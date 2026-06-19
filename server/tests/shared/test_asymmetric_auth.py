"""非对称验签验收（03 §9.5，D23）：RS256 签发/公钥验签、JWKS、错误 key 拒绝、exp 过期。

设计口径：Manager 按 tenant 持私钥签发；用户端只持公钥/JWKS 本地无状态验签；
错误 key / 篡改 / 过期一律拒绝；签发能力绝不下发用户端（边界扫描守）。
"""

import time

import pytest

from shared.auth import (
    RS256TokenSigner,
    RS256TokenVerifier,
    generate_rsa_keypair,
    jwks_from_public_pem,
)
from shared.contracts.auth import TokenClaims
from shared.errors import Unauthorized


def _claims(exp_in: int = 3600, **kw) -> TokenClaims:
    base = dict(user_id="u1", tenant_id="t1", roles=["owner"], exp=int(time.time()) + exp_in)
    base.update(kw)
    return TokenClaims(**base)


def test_rs256_sign_and_verify_roundtrip():
    priv, pub = generate_rsa_keypair()
    signer = RS256TokenSigner(priv, kid="k1")
    verifier = RS256TokenVerifier.from_public_pems({"k1": pub})
    out = verifier.verify(signer.sign(_claims()))
    assert out.user_id == "u1"
    assert out.tenant_id == "t1"
    assert out.roles == ["owner"]


def test_rs256_wrong_public_key_rejected():
    priv_a, _ = generate_rsa_keypair()
    _, pub_b = generate_rsa_keypair()
    signer = RS256TokenSigner(priv_a, kid="k1")
    verifier = RS256TokenVerifier.from_public_pems({"k1": pub_b})  # 错误公钥
    with pytest.raises(Unauthorized):
        verifier.verify(signer.sign(_claims()))


def test_rs256_unknown_kid_rejected():
    priv, pub = generate_rsa_keypair()
    signer = RS256TokenSigner(priv, kid="rotated-out")
    verifier = RS256TokenVerifier.from_public_pems({"current": pub})
    with pytest.raises(Unauthorized):
        verifier.verify(signer.sign(_claims()))


def test_rs256_tampered_token_rejected():
    priv, pub = generate_rsa_keypair()
    signer = RS256TokenSigner(priv, kid="k1")
    verifier = RS256TokenVerifier.from_public_pems({"k1": pub})
    token = signer.sign(_claims())
    with pytest.raises(Unauthorized):
        verifier.verify(token + "tamper")


def test_rs256_expired_token_rejected():
    priv, pub = generate_rsa_keypair()
    signer = RS256TokenSigner(priv, kid="k1")
    verifier = RS256TokenVerifier.from_public_pems({"k1": pub})
    token = signer.sign(_claims(exp_in=-10))  # 已过期
    with pytest.raises(Unauthorized):
        verifier.verify(token)


def test_jwks_export_contains_kid_and_rsa_params():
    _, pub = generate_rsa_keypair()
    jwks = jwks_from_public_pem("k1", pub)
    key = jwks["keys"][0]
    assert key["kid"] == "k1"
    assert key["kty"] == "RSA"
    assert key["alg"] == "RS256"
    assert key["use"] == "sig"
    assert key["n"] and key["e"]
    # 公钥导出不得泄漏私钥分量
    for private_param in ("d", "p", "q", "dp", "dq", "qi"):
        assert private_param not in key


def test_verifier_from_jwks_roundtrip():
    """用户端拿到的就是 JWKS（公开材料），须能据此验签 Manager 私钥签的 token。"""
    priv, pub = generate_rsa_keypair()
    signer = RS256TokenSigner(priv, kid="k1")
    jwks = jwks_from_public_pem("k1", pub)
    verifier = RS256TokenVerifier.from_jwks(jwks)
    out = verifier.verify(signer.sign(_claims()))
    assert out.user_id == "u1"


def test_malformed_token_rejected():
    priv, pub = generate_rsa_keypair()
    RS256TokenSigner(priv, kid="k1")
    verifier = RS256TokenVerifier.from_public_pems({"k1": pub})
    with pytest.raises(Unauthorized):
        verifier.verify("not-a-jwt")
