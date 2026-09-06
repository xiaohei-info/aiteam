"""WebAuthn 注册/认证 ceremony（Manager可信origin及用户绑定）。

把旧 WebUI 单租户的 CBOR/ES256 校验逻辑下沉为无框架 helper，依赖：
- ``cryptography``（已列为 server 依赖）做公钥加载与签名校验。
- ``passkey_credential`` 表（PG/RLS）做凭据持久化。

challenge 只落进程内存 + TTL（不落库，与旧实现同口径；worker 重启即失效可接受）。
tenant 隔离靠调用方传 rp_id / PasskeyStore，本模块不直触 tenant。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any


class CeremonyError(ValueError):
    """用户可纠正的 WebAuthn 校验失败。"""


_CHALLENGE_TTL = 300
_RP_NAME = "AI Team Manager"

_challenges: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


# ---- base64url ----
def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64u_decode(value: str | bytes) -> bytes:
    if isinstance(value, bytes):
        value = value.decode("ascii")
    value = str(value).strip()
    value += "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value.encode("ascii"))


# ---- challenge 内存落地（TTL，不落库）----
def _cleanup_challenges(now: float) -> None:
    expired = [k for k, v in _challenges.items() if now - v.get("ts", 0) > _CHALLENGE_TTL]
    for k in expired:
        _challenges.pop(k, None)


def _store_challenge(challenge: str, kind: str, rp_id: str, origin: str, scope: str, credential_ids: list[str]) -> None:
    now = time.time()
    with _lock:
        _cleanup_challenges(now)
        _challenges[challenge] = {"kind": kind, "rp_id": rp_id, "origin": origin, "scope": scope, "credential_ids": list(credential_ids), "ts": now}


def _consume_challenge(challenge: str, kind: str) -> dict[str, Any]:
    with _lock:
        _cleanup_challenges(time.time())
        entry = _challenges.pop(challenge, None)
    if not entry or entry.get("kind") != kind:
        raise CeremonyError("Passkey challenge expired. Try again.")
    return entry


# ---- CBOR ----
@dataclass
class _Cbor:
    data: bytes
    pos: int = 0

    def read(self, n: int) -> bytes:
        if self.pos + n > len(self.data):
            raise CeremonyError("Malformed CBOR data")
        out = self.data[self.pos:self.pos + n]
        self.pos += n
        return out

    def item(self) -> Any:
        initial = self.read(1)[0]
        major, addl = initial >> 5, initial & 0x1F
        val = self._val(addl)
        if major == 0:
            return val
        if major == 1:
            return -1 - val
        if major == 2:
            return self.read(val)
        if major == 3:
            return self.read(val).decode("utf-8")
        if major == 4:
            return [self.item() for _ in range(val)]
        if major == 5:
            return {self.item(): self.item() for _ in range(val)}
        if major == 7:
            if val == 20:
                return False
            if val == 21:
                return True
            if val == 22:
                return None
        raise CeremonyError("Unsupported CBOR data")

    def _val(self, addl: int) -> int:
        if addl < 24:
            return addl
        if addl == 24:
            return self.read(1)[0]
        if addl == 25:
            return int.from_bytes(self.read(2), "big")
        if addl == 26:
            return int.from_bytes(self.read(4), "big")
        if addl == 27:
            return int.from_bytes(self.read(8), "big")
        raise CeremonyError("Indefinite CBOR values are not supported")


def _cbor_loads(data: bytes) -> Any:
    parser = _Cbor(data)
    value = parser.item()
    if parser.pos != len(data):
        raise CeremonyError("Trailing CBOR data")
    return value


# ---- authenticatorData / COSE ----
def _parse_auth_data(auth_data: bytes, rp_id: str) -> dict[str, Any]:
    if len(auth_data) < 37:
        raise CeremonyError("Malformed authenticator data")
    expected = hashlib.sha256(rp_id.encode("idna")).digest()
    if not hmac.compare_digest(auth_data[:32], expected):
        raise CeremonyError("Passkey RP ID mismatch")
    flags = auth_data[32]
    if flags & 0x05 != 0x05:
        raise CeremonyError("Passkey user presence and verification required")
    sign_count = int.from_bytes(auth_data[33:37], "big")
    return {"flags": flags, "sign_count": sign_count, "rest": auth_data[37:]}


def _cose_es256_to_pub(cose: dict) -> Any:
    """COSE key(kty=2, crv=1, alg=-7) -> cryptography public key。"""
    from cryptography.hazmat.primitives.asymmetric import ec
    alg = cose.get(3)
    kty = cose.get(1)
    crv = cose.get(-1)
    x = cose.get(-2)
    y = cose.get(-3)
    if alg != -7 or kty != 2 or crv != 1 or not isinstance(x, bytes) or not isinstance(y, bytes):
        raise CeremonyError("Only ES256 passkeys are supported")
    numbers = ec.EllipticCurvePublicNumbers(int.from_bytes(x, "big"), int.from_bytes(y, "big"), ec.SECP256R1())
    return numbers.public_key()


def _credential_from_rest(rest: bytes) -> tuple[bytes, Any]:
    if len(rest) < 18:
        raise CeremonyError("Malformed credential data")
    cred_len = int.from_bytes(rest[16:18], "big")
    credential_id = rest[18:18 + cred_len]
    cose_bytes = rest[18 + cred_len:]
    pub = _cose_es256_to_pub(_cbor_loads(cose_bytes))
    return credential_id, pub


def _client_data(encoded: str, expected_type: str, challenge_kind: str) -> tuple[dict, dict, bytes]:
    raw = _b64u_decode(encoded)
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise CeremonyError("Malformed client data") from exc
    if not isinstance(data, dict):
        raise CeremonyError("Malformed client data")
    if data.get("type") != expected_type:
        raise CeremonyError("Unexpected passkey response type")
    challenge = data.get("challenge")
    if not isinstance(challenge, str):
        raise CeremonyError("Missing passkey challenge")
    entry = _consume_challenge(challenge, challenge_kind)
    return data, entry, raw


def _validate_client(encoded: str, expected_type: str, kind: str, rp_id: str, origin: str, scope: str):
    data, entry, _raw = _client_data(encoded, expected_type, kind)
    if (entry["rp_id"] != rp_id or entry["origin"] != origin or entry["scope"] != scope
            or data.get("origin") != origin or data.get("crossOrigin", False) is not False):
        raise CeremonyError("Passkey origin or challenge scope mismatch")
    return entry


# ---- public ceremonies ----
def registration_options(rp_id: str, existing_credential_ids: list[str], *, origin: str, scope: str, user_id: str) -> dict[str, Any]:
    challenge = _b64u(secrets.token_bytes(32))
    _store_challenge(challenge, "register", rp_id, origin, scope, existing_credential_ids)
    return {
        "challenge": challenge,
        "rp": {"name": _RP_NAME, "id": rp_id},
        "user": {"id": _b64u(user_id.encode()), "name": "manager-user", "displayName": "manager-user"},
        "pubKeyCredParams": [{"type": "public-key", "alg": -7}],
        "authenticatorSelection": {"residentKey": "preferred", "userVerification": "required"},
        "timeout": 60000,
        "attestation": "none",
        "excludeCredentials": [{"type": "public-key", "id": cid} for cid in existing_credential_ids],
    }


def authentication_options(rp_id: str, allow_credential_ids: list[str], *, origin: str, scope: str) -> dict[str, Any]:
    challenge = _b64u(secrets.token_bytes(32))
    _store_challenge(challenge, "login", rp_id, origin, scope, allow_credential_ids)
    return {
        "challenge": challenge,
        "rpId": rp_id,
        "allowCredentials": [{"type": "public-key", "id": cid} for cid in allow_credential_ids],
        "timeout": 60000,
        "userVerification": "required",
    }


def finish_registration(payload: dict, rp_id: str, *, origin: str, scope: str) -> dict[str, Any]:
    """校验注册响应，返回 {credential_id, public_key_pem, sign_count, label}。抛出 CeremonyError。"""
    from cryptography.hazmat.primitives import hashes, serialization
    response = payload.get("response") or {}
    _validate_client(response.get("clientDataJSON", ""), "webauthn.create", "register", rp_id, origin, scope)
    att_obj = _cbor_loads(_b64u_decode(response.get("attestationObject", "")))
    if not isinstance(att_obj, dict) or not isinstance(att_obj.get("authData"), bytes):
        raise CeremonyError("Malformed attestation object")
    parsed = _parse_auth_data(att_obj["authData"], rp_id)
    if not (parsed["flags"] & 0x40):
        raise CeremonyError("Passkey credential data missing")
    credential_id, pub = _credential_from_rest(parsed["rest"])
    pem = pub.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode("ascii")
    cred_id = _b64u(credential_id)
    label = (str(payload.get("label") or "Passkey").strip()[:80] or "Passkey")
    return {"credential_id": cred_id, "public_key_pem": pem, "sign_count": parsed["sign_count"], "label": label}


def finish_login(payload: dict, rp_id: str, *, stored_pem: str, old_sign_count: int, origin: str, scope: str) -> dict[str, Any]:
    """校验登录断言，返回 {sign_count}。抛出 CeremonyError。"""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    response = payload.get("response") or {}
    entry = _validate_client(response.get("clientDataJSON", ""), "webauthn.get", "login", rp_id, origin, scope)
    if entry["credential_ids"] and payload.get("id") not in entry["credential_ids"]:
        raise CeremonyError("Passkey credential does not match challenge")
    auth_data = _b64u_decode(response.get("authenticatorData", ""))
    parsed = _parse_auth_data(auth_data, rp_id)
    signature = _b64u_decode(response.get("signature", ""))
    public_key = serialization.load_pem_public_key(stored_pem.encode("ascii"))
    client_raw = _b64u_decode(response.get("clientDataJSON", ""))
    signed = auth_data + hashlib.sha256(client_raw).digest()
    try:
        public_key.verify(signature, signed, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature as exc:
        raise CeremonyError("Passkey signature verification failed") from exc
    new_count = parsed["sign_count"]
    if new_count and old_sign_count and new_count <= old_sign_count:
        raise CeremonyError("Passkey sign counter did not advance")
    return {"sign_count": new_count}
