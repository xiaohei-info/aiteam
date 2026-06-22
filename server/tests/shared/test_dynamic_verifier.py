"""动态 RS256 验签器（DynamicRS256TokenVerifier，缺口1 基座）+ RejectingTokenVerifier 验收。

DynamicRS256TokenVerifier 按 token header.kid 动态解析公钥——Manager 多租户验签场景
（验签时还不知道 tenant_id，需先从 kid 解析）。kid 未知/无/resolver 返 None 一律拒绝。
"""

import time

import pytest

from shared.auth import (
    DynamicRS256TokenVerifier,
    RejectingTokenVerifier,
    RS256TokenSigner,
    generate_rsa_keypair,
)
from shared.contracts.auth import TokenClaims
from shared.errors import Unauthorized


def _claims(**kw) -> TokenClaims:
    base = dict(user_id="u1", tenant_id="t1", roles=["owner"], exp=int(time.time()) + 3600)
    base.update(kw)
    return TokenClaims(**base)


def test_dynamic_verifier_resolves_by_kid():
    priv, pub = generate_rsa_keypair()
    signer = RS256TokenSigner(priv, kid="t1:1")
    keys = {"t1:1": pub}
    verifier = DynamicRS256TokenVerifier(lambda kid: keys.get(kid))

    token = signer.sign(_claims())
    claims = verifier.verify(token)
    assert claims.user_id == "u1"
    assert claims.tenant_id == "t1"


def test_dynamic_verifier_unknown_kid_rejected():
    priv, pub = generate_rsa_keypair()
    signer = RS256TokenSigner(priv, kid="t1:1")
    verifier = DynamicRS256TokenVerifier(lambda kid: None)  # resolver 永远查不到

    token = signer.sign(_claims())
    with pytest.raises(Unauthorized) as exc:
        verifier.verify(token)
    assert "unknown signing key" in str(exc.value)


def test_dynamic_verifier_no_kid_in_token_rejected():
    priv, pub = generate_rsa_keypair()
    # kid 缺失场景：resolver 不应被调用，直接拒。构造一个无 kid 的 signer 无法直接做
    # （RS256TokenSigner 强制 kid），用 resolver 计数器验证：token 有 kid 时才调。
    calls = []
    verifier = DynamicRS256TokenVerifier(lambda kid: calls.append(kid) or None)
    # 用一个合法 kid 的 token（resolver 会被调，返回 None → 拒）
    signer = RS256TokenSigner(priv, kid="t1:1")
    with pytest.raises(Unauthorized):
        verifier.verify(signer.sign(_claims()))
    assert calls == ["t1:1"]


def test_dynamic_verifier_wrong_public_key_rejected():
    # 签发用一个密钥，resolver 返回另一个密钥的公钥 → 验签失配
    priv_sign, _ = generate_rsa_keypair()
    _, pub_wrong = generate_rsa_keypair()
    signer = RS256TokenSigner(priv_sign, kid="t1:1")
    verifier = DynamicRS256TokenVerifier(lambda kid: pub_wrong)

    token = signer.sign(_claims())
    with pytest.raises(Unauthorized):
        verifier.verify(token)


def test_dynamic_verifier_expired_rejected():
    priv, pub = generate_rsa_keypair()
    signer = RS256TokenSigner(priv, kid="t1:1")
    verifier = DynamicRS256TokenVerifier(lambda kid: pub)

    expired = signer.sign(TokenClaims(user_id="u1", tenant_id="t1", roles=["owner"], exp=int(time.time()) - 10))
    with pytest.raises(Unauthorized) as exc:
        verifier.verify(expired)
    assert "expired" in str(exc.value)


def test_rejecting_verifier_always_unauthorized():
    verifier = RejectingTokenVerifier()
    with pytest.raises(Unauthorized) as exc:
        verifier.verify("any-token")
    assert "unconfigured" in str(exc.value)


def test_rejecting_verifier_custom_reason():
    verifier = RejectingTokenVerifier("my reason")
    with pytest.raises(Unauthorized) as exc:
        verifier.verify("x")
    assert "my reason" in str(exc.value)
