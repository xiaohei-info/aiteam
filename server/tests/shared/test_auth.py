"""shared/auth 验收（03 §9）：dev token 签发/验签、鉴权角色、TenantContext 构造。"""

import pytest

from shared.auth import DevTokenService, authorize, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.errors import Forbidden, Unauthorized


def test_dev_token_roundtrip():
    svc = DevTokenService()
    claims = TokenClaims(user_id="u1", tenant_id="t1", roles=["owner"], exp=123)
    out = svc.verify(svc.sign(claims))
    assert out.user_id == "u1"
    assert out.tenant_id == "t1"


def test_dev_token_bad_signature_rejected():
    svc = DevTokenService()
    token = svc.sign(TokenClaims(user_id="u1", exp=1))
    with pytest.raises(Unauthorized):
        svc.verify(token + "tamper")
    with pytest.raises(Unauthorized):
        svc.verify("not-a-token")


def test_different_secret_rejects():
    a = DevTokenService("secret-a")
    b = DevTokenService("secret-b")
    token = a.sign(TokenClaims(user_id="u1", exp=1))
    with pytest.raises(Unauthorized):
        b.verify(token)


def test_authorize_allows_and_denies():
    claims = TokenClaims(user_id="u1", roles=["member"], exp=1)
    authorize(claims, ["member", "owner"])  # 不抛
    with pytest.raises(Forbidden):
        authorize(claims, ["owner"])


def test_tenant_context_requires_tenant():
    with_tenant = TokenClaims(user_id="u1", tenant_id="t1", roles=["member"], exp=1)
    ctx = tenant_context_from(with_tenant)
    assert ctx.tenant_id == "t1"
    no_tenant = TokenClaims(user_id="u1", roles=["system_admin"], exp=1)
    with pytest.raises(Forbidden):
        tenant_context_from(no_tenant)
