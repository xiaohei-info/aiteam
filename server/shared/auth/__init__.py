"""认证底座（03 §9，D8/D23）。

职责拆分（03 §9.8）：
- 验签 + 解身份：纯计算，共享库（本模块），各端 import，不是网络服务、不回调。
- 鉴权②：纯逻辑 helper（authorize），策略留各端。
- 签发 token：纯计算 helper，仅凭据持有端校验通过后调用。

生产口径（D23）：**非对称签名**——Manager 按 tenant 持私钥签发，Agent 只持公钥/JWKS 验签；
禁止向用户端下发 HMAC 对称签名密钥。真实 RSA/JWKS + key rotation 留详设（03 §9.5）。

本模块提供：
- TokenSigner/TokenVerifier 抽象。
- **生产口径** RS256TokenSigner / RS256TokenVerifier（RSA 非对称签名 + JWKS，D23）：
  Manager 持私钥签发、用户端只持公钥/JWKS 本地无状态验签，含 exp 过期校验。
- 仅供 dev/测试的 DevTokenService（对称自包含 token，**禁下发用户端**）。
- FastAPI 依赖（解出 TokenClaims / 构造 TenantContext / authorize 角色校验）。
"""

from __future__ import annotations

import base64
import hashlib
import json
from abc import ABC, abstractmethod

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, Request

from shared.contracts.auth import TokenClaims
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden, Unauthorized


class TokenVerifier(ABC):
    """本地无状态验签（03 §9.5）。生产实现用公钥/JWKS。"""

    @abstractmethod
    def verify(self, token: str) -> TokenClaims:
        ...


class TokenSigner(ABC):
    """token 签发（03 §9.5）。仅凭据持有端持私钥实现；用户端不实现。"""

    @abstractmethod
    def sign(self, claims: TokenClaims) -> str:
        ...


class DevTokenService(TokenSigner, TokenVerifier):
    """⚠️ 仅供 dev/测试，**非生产**。

    用 base64(json) + sha256(secret+payload) 做最简自包含 token，验证一致性即可。
    生产**必须**替换为非对称签名实现（Manager 私钥签发 / Agent 公钥验签，D23），
    禁止把本类或任何对称密钥下发到用户端。
    """

    def __init__(self, secret: str = "dev-only-not-for-production"):
        self._secret = secret

    def _sig(self, payload_b64: str) -> str:
        return hashlib.sha256((self._secret + payload_b64).encode()).hexdigest()

    def sign(self, claims: TokenClaims) -> str:
        payload = base64.urlsafe_b64encode(claims.model_dump_json().encode()).decode()
        return f"{payload}.{self._sig(payload)}"

    def verify(self, token: str) -> TokenClaims:
        try:
            payload, sig = token.split(".", 1)
        except ValueError as exc:
            raise Unauthorized("malformed token") from exc
        if self._sig(payload) != sig:
            raise Unauthorized("bad signature")
        try:
            data = json.loads(base64.urlsafe_b64decode(payload.encode()))
        except Exception as exc:  # noqa: BLE001
            raise Unauthorized("undecodable token") from exc
        return TokenClaims(**data)


# ---- 生产口径：RS256 非对称签名（D23，03 §9.5）----

_ALG = "RS256"


def generate_rsa_keypair(bits: int = 2048) -> tuple[str, str]:
    """生成 RSA 私钥/公钥（PEM 字符串）。私钥仅控制面持有，公钥/JWKS 下发用户端。

    生产环境密钥应由控制面安全生成/托管并按 tenant 持有；本 helper 供初始化与测试。
    """
    key = rsa.generate_private_key(public_exponent=65537, key_size=bits)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return private_pem, public_pem


def _b64url_uint(value: int) -> str:
    raw = value.to_bytes((value.bit_length() + 7) // 8 or 1, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def jwks_from_public_pem(kid: str, public_pem: str) -> dict:
    """把公钥 PEM 导成 JWKS（仅公开分量）。用户端首登领取后据此本地验签（03 §9.5）。"""
    pub = serialization.load_pem_public_key(public_pem.encode())
    numbers = pub.public_numbers()  # type: ignore[attr-defined]
    return {
        "keys": [
            {
                "kty": "RSA",
                "use": "sig",
                "alg": _ALG,
                "kid": kid,
                "n": _b64url_uint(numbers.n),
                "e": _b64url_uint(numbers.e),
            }
        ]
    }


class RS256TokenSigner(TokenSigner):
    """RSA 私钥签发（仅凭据持有端 Manager/Operator 实现，D23）。用户端绝不实例化。"""

    def __init__(self, private_pem: str, *, kid: str):
        self._private_pem = private_pem
        self._kid = kid

    @property
    def kid(self) -> str:
        return self._kid

    def public_pem(self) -> str:
        key = serialization.load_pem_private_key(self._private_pem.encode(), password=None)
        return key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode()

    def jwks(self) -> dict:
        return jwks_from_public_pem(self._kid, self.public_pem())

    def sign(self, claims: TokenClaims) -> str:
        return jwt.encode(
            claims.model_dump(exclude_none=True),
            self._private_pem,
            algorithm=_ALG,
            headers={"kid": self._kid},
        )


class RS256TokenVerifier(TokenVerifier):
    """本地无状态公钥验签（用户端只持此能力，D23）。含 exp 过期校验。

    多 kid（key rotation）：按 token header.kid 选公钥；未知 kid 一律拒。
    """

    def __init__(self, public_pems_by_kid: dict[str, str]):
        if not public_pems_by_kid:
            raise ValueError("at least one public key required")
        self._keys = dict(public_pems_by_kid)

    @classmethod
    def from_public_pems(cls, public_pems_by_kid: dict[str, str]) -> "RS256TokenVerifier":
        return cls(public_pems_by_kid)

    @classmethod
    def from_jwks(cls, jwks: dict) -> "RS256TokenVerifier":
        """从 JWKS 构造验签器（用户端首登领取 JWKS 后用此）。"""
        pems: dict[str, str] = {}
        for key in jwks.get("keys", []):
            algo = jwt.algorithms.RSAAlgorithm  # type: ignore[attr-defined]
            pub = algo.from_jwk(json.dumps(key))
            pem = pub.public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            ).decode()
            pems[key["kid"]] = pem
        return cls(pems)

    def verify(self, token: str) -> TokenClaims:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise Unauthorized("malformed token") from exc
        kid = header.get("kid")
        public_pem = self._keys.get(kid) if kid else None
        if public_pem is None:
            raise Unauthorized("unknown signing key")
        return _decode_rs256(token, public_pem)


def _decode_rs256(token: str, public_pem: str) -> TokenClaims:
    """RS256 解码尾（验签 + 解 claims + 过期检查）。各 RS256 验签器共用，行为一致。

    异常 message 字面量与原 RS256TokenVerifier.verify 保持一致：
    "token expired" / "bad signature" / "undecodable token"。
    """
    try:
        payload = jwt.decode(token, public_pem, algorithms=[_ALG])
    except jwt.ExpiredSignatureError as exc:
        raise Unauthorized("token expired") from exc
    except jwt.PyJWTError as exc:
        raise Unauthorized("bad signature") from exc
    try:
        return TokenClaims(**payload)
    except Exception as exc:  # noqa: BLE001
        raise Unauthorized("undecodable token") from exc


class DynamicRS256TokenVerifier(TokenVerifier):
    """按 token header.kid 动态解析公钥的 RS256 验签器（多 tenant / 未知 tenant 场景）。

    生产口径（D23）：Manager 作为多租户身份源，验签时还不知道 tenant_id——需先从 token
    header 的 kid 解析（kid 形如 "{tenant_id}:1"），再按 tenant 查公钥。本类把"kid → 公钥"
    的解析策略交给调用方（resolve_public_pem 回调），自身只负责"取到公钥后 RS256 验签"。

    - resolve_public_pem(kid) -> public_pem(str) | None：kid 未知 / 格式错 / 无记录返回 None。
    - kid 缺失 / resolver 返回 None → 一律 Unauthorized("unknown signing key")，不回退不放行。
    - 不缓存（单一职责）；缓存由 resolver 内部决定。
    """

    def __init__(self, resolve_public_pem):
        self._resolve = resolve_public_pem

    def verify(self, token: str) -> TokenClaims:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise Unauthorized("malformed token") from exc
        kid = header.get("kid")
        public_pem = self._resolve(kid) if kid else None
        if public_pem is None:
            raise Unauthorized("unknown signing key")
        return _decode_rs256(token, public_pem)


class RejectingTokenVerifier(TokenVerifier):
    """恒拒绝验签器：verify 必抛 Unauthorized。

    用于签发密钥源未配置时（如 Manager 无 admin DSN、Operation 未初始化密钥），
    避免验签静默放行——宁可全 401 也不放过。调用方应在配置就绪后切换为真验签器。
    """

    def __init__(self, reason: str = "signing key store unconfigured"):
        self._reason = reason

    def verify(self, token: str) -> TokenClaims:  # noqa: ARG002
        raise Unauthorized(self._reason)


def _bearer_token(request: Request) -> str:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise Unauthorized("missing bearer token")
    return header[len("Bearer "):].strip()


def require_claims(verifier: TokenVerifier):
    """FastAPI 依赖工厂：受保护端点用 Depends(require_claims(verifier)) 解出 TokenClaims。

    无 token / 验签失败 / 过期 → 401（公开端点不挂此依赖即放行，03 §9.6）。
    """

    def _dep(request: Request) -> TokenClaims:
        return verifier.verify(_bearer_token(request))

    return _dep


def tenant_context_from(claims: TokenClaims) -> TenantContext:
    """由 claims 构造 TenantContext（Manager 内 tenant_id 必有）。"""
    if not claims.tenant_id:
        raise Forbidden("token missing tenant scope")
    return TenantContext(
        tenant_id=claims.tenant_id,
        user_id=claims.user_id,
        roles=claims.roles,
        enterprise_id=claims.enterprise_id,
    )


def authorize(claims: TokenClaims, allowed_roles: list[str]) -> None:
    """鉴权②角色校验（03 §9.7）。越权 → 403。资源归属/成员级授权由各端业务自行追加校验。"""
    if not set(claims.roles) & set(allowed_roles):
        raise Forbidden(f"requires one of roles: {allowed_roles}")
