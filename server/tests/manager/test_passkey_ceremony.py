"""Synthetic WebAuthn ES256 authenticator: actual CBOR, RP hash, client data and signatures."""
import hashlib
import json

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

from manager_service import passkey_ceremony as ceremony
from manager_service.auth_origin import AuthOrigin, AuthOriginUnconfigured

ORIGIN = "https://manager.example"
RP = "manager.example"
SCOPE = "tenant:user"


def cbor(value):
    if isinstance(value, int):
        major, n = (0, value) if value >= 0 else (1, -1-value)
        return bytes([(major << 5) | n]) if n < 24 else bytes([(major << 5) | 24, n])
    if isinstance(value, (bytes, str)):
        raw = value.encode() if isinstance(value, str) else value
        major = 3 if isinstance(value, str) else 2
        header = bytes([(major << 5) | len(raw)]) if len(raw) < 24 else bytes([(major << 5) | 24, len(raw)])
        return header + raw
    return bytes([0xa0 | len(value)]) + b"".join(cbor(k)+cbor(v) for k, v in value.items())


def registration_payload(options, *, key=None, origin=ORIGIN, rp=RP, flags=0x45):
    key = key or ec.generate_private_key(ec.SECP256R1())
    pub = key.public_key().public_numbers()
    cose = {1: 2, 3: -7, -1: 1, -2: pub.x.to_bytes(32, "big"), -3: pub.y.to_bytes(32, "big")}
    cred_id = b"synthetic-credential"
    auth = hashlib.sha256(rp.encode()).digest() + bytes([flags]) + (0).to_bytes(4, "big")
    auth += bytes(16) + len(cred_id).to_bytes(2, "big") + cred_id + cbor(cose)
    client = json.dumps({"type": "webauthn.create", "challenge": options["challenge"], "origin": origin}).encode()
    return {"response": {"clientDataJSON": ceremony._b64u(client), "attestationObject": ceremony._b64u(cbor({"authData": auth}))}}, key


def login_payload(options, key, *, origin=ORIGIN, rp=RP, count=1, flags=0x05):
    client = json.dumps({"type": "webauthn.get", "challenge": options["challenge"], "origin": origin}).encode()
    auth = hashlib.sha256(rp.encode()).digest() + bytes([flags]) + count.to_bytes(4, "big")
    signature = key.sign(auth + hashlib.sha256(client).digest(), ec.ECDSA(hashes.SHA256()))
    return {"id": ceremony._b64u(b"synthetic-credential"), "response": {
        "clientDataJSON": ceremony._b64u(client), "authenticatorData": ceremony._b64u(auth), "signature": ceremony._b64u(signature)}}


def options():
    return ceremony.registration_options(RP, [], origin=ORIGIN, scope=SCOPE, user_id="user")


def test_registration_and_assertion_verify_origin_scope_signature_and_replay():
    payload, key = registration_payload(options())
    result = ceremony.finish_registration(payload, RP, origin=ORIGIN, scope=SCOPE)
    login = ceremony.authentication_options(RP, [result["credential_id"]], origin=ORIGIN, scope="tenant")
    assertion = login_payload(login, key)
    kwargs = dict(stored_pem=result["public_key_pem"], old_sign_count=0, origin=ORIGIN, scope="tenant")
    assert ceremony.finish_login(assertion, RP, **kwargs) == {"sign_count": 1}
    with pytest.raises(ceremony.CeremonyError):
        ceremony.finish_login(assertion, RP, **kwargs)


@pytest.mark.parametrize("override", [{"origin": "https://evil.example"}, {"rp": "evil.example"}, {"flags": 0x41}])
def test_registration_rejects_wrong_origin_rp_or_missing_verification(override):
    payload, _ = registration_payload(options(), **override)
    with pytest.raises(ceremony.CeremonyError):
        ceremony.finish_registration(payload, RP, origin=ORIGIN, scope=SCOPE)


@pytest.mark.parametrize("scope", ["other-tenant:user", "tenant:other-user"])
def test_registration_challenge_cannot_cross_principal(scope):
    payload, _ = registration_payload(options())
    with pytest.raises(ceremony.CeremonyError):
        ceremony.finish_registration(payload, RP, origin=ORIGIN, scope=scope)


def test_expired_challenge_cannot_be_consumed(monkeypatch):
    payload, _ = registration_payload(options())
    now = ceremony.time.time()
    monkeypatch.setattr(ceremony.time, "time", lambda: now+301)
    with pytest.raises(ceremony.CeremonyError):
        ceremony.finish_registration(payload, RP, origin=ORIGIN, scope=SCOPE)


@pytest.mark.parametrize("value", ["", "http://manager.example", "https://manager.example/path", "https://user@manager.example", "https://manager.example/", "http://localhost:8080"])
def test_missing_or_untrusted_origin_is_not_configured(value):
    with pytest.raises(AuthOriginUnconfigured):
        AuthOrigin.parse(value)


def test_explicit_test_loopback_origin():
    assert AuthOrigin.parse("http://localhost:8080", environment="test").rp_id == "localhost"


def test_ip_origin_is_oauth_compatible_but_not_passkey_rp():
    origin = AuthOrigin.parse("http://127.0.0.1:8080", environment="test")
    assert origin.oauth_redirect_uri == "http://127.0.0.1:8080/auth/oauth/callback"
    with pytest.raises(AuthOriginUnconfigured, match="DNS"):
        origin.require_passkey_rp()


def test_client_data_must_be_an_object_not_arbitrary_json():
    payload = {"response": {"clientDataJSON": ceremony._b64u(b"[]")}}
    with pytest.raises(ceremony.CeremonyError, match="Malformed client data"):
        ceremony.finish_registration(payload, RP, origin=ORIGIN, scope=SCOPE)
