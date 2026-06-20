"""owner 首登重置 + member 登录 端到端验收（integration，真 PG；03 §9.4，D8/D23）。

口径（03 §9.4）：
- owner 首登：凭 bootstrap 初始密码 → 强制重置 → 新密码 hash 落本 tenant；此后本地校验。
- member：负责人在租户内建账号 → member 手机号+密码登录 → 单一 token 出口（RS256 含 tenant_id）。
- 跨租户不串线：同手机号属不同企业是不同身份。
- token RS256 签发、公钥/JWKS 本地验签；密码 hash 不可逆。
"""

import uuid

import pytest

from shared.auth import RS256TokenVerifier
from shared.errors import Forbidden, Unauthorized

from manager_service.auth_service import (
    LoginInput,
    OwnerResetInput,
    build_auth_service,
)

pytestmark = pytest.mark.integration


@pytest.fixture()
def svc(migrated_db, admin_url, two_tenants):
    tid_a, tid_b = two_tenants
    # 业务连接 app_rw（migrated_db）+ 管理连接 admin_url（签名私钥库，#60）。
    service = build_auth_service(migrated_db, admin_dsn=admin_url)
    return service, tid_a, tid_b


def test_owner_first_login_requires_reset_then_logs_in(svc):
    service, tid_a, _ = svc
    phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    service.provision_owner(tid_a, phone=phone, bootstrap_password="init-Pass-123")

    # 首登：bootstrap 校验通过但标记 must_reset → 拒绝直接签发，要求重置。
    with pytest.raises(Forbidden):
        service.login(LoginInput(tenant_id=tid_a, account=phone, password="init-Pass-123"))

    # 重置：旧密码校验 + 设新密码。
    result = service.owner_reset(
        OwnerResetInput(tenant_id=tid_a, account=phone, old_password="init-Pass-123", new_password="new-Pass-456")
    )
    assert result.claims.tenant_id == tid_a
    assert "owner" in result.claims.roles

    # 重置后用新密码本地校验登录，签发可验签 token。
    out = service.login(LoginInput(tenant_id=tid_a, account=phone, password="new-Pass-456"))
    verifier = RS256TokenVerifier.from_jwks(service.jwks(tid_a))
    claims = verifier.verify(out.token)
    assert claims.tenant_id == tid_a
    assert claims.user_id == out.claims.user_id

    # 旧 bootstrap 密码已失效。
    with pytest.raises(Unauthorized):
        service.login(LoginInput(tenant_id=tid_a, account=phone, password="init-Pass-123"))


def test_member_login(svc):
    service, tid_a, _ = svc
    phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    service.create_member(tid_a, phone=phone, initial_password="member-Pass-1", display_name="Alice")

    out = service.login(LoginInput(tenant_id=tid_a, account=phone, password="member-Pass-1"))
    assert out.claims.tenant_id == tid_a
    assert out.claims.roles == ["member"]
    verifier = RS256TokenVerifier.from_jwks(service.jwks(tid_a))
    assert verifier.verify(out.token).user_id == out.claims.user_id

    with pytest.raises(Unauthorized):
        service.login(LoginInput(tenant_id=tid_a, account=phone, password="wrong"))


def test_same_phone_different_tenants_no_crosswire(svc):
    """同手机号属不同企业是不同身份，不能跨 tenant 串线（unique(tenant_id, provider, external_id)）。"""
    service, tid_a, tid_b = svc
    phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    service.create_member(tid_a, phone=phone, initial_password="pass-A-111", display_name="A")
    service.create_member(tid_b, phone=phone, initial_password="pass-B-222", display_name="B")

    out_a = service.login(LoginInput(tenant_id=tid_a, account=phone, password="pass-A-111"))
    out_b = service.login(LoginInput(tenant_id=tid_b, account=phone, password="pass-B-222"))
    assert out_a.claims.user_id != out_b.claims.user_id
    assert out_a.claims.tenant_id == tid_a
    assert out_b.claims.tenant_id == tid_b

    # tenant A 的密码不能登 tenant B。
    with pytest.raises(Unauthorized):
        service.login(LoginInput(tenant_id=tid_b, account=phone, password="pass-A-111"))


def test_password_hash_is_not_reversible(svc, admin_url):
    """凭据落库为 hash，不存明文（03 §9.3 / 04 §6.1 owner_credential 不存可逆密码）。

    直读 auth_identity 走管理连接（superuser 绕 RLS）以拿到落库密文（#60：业务连接 app_rw
    在未设 tenant 时受 RLS 约束读不到行）。
    """
    service, tid_a, _ = svc
    phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    service.create_member(tid_a, phone=phone, initial_password="secret-Pass-9", display_name="X")

    import psycopg

    with psycopg.connect(admin_url, autocommit=True) as conn:
        secret = conn.execute(
            "SELECT secret FROM auth_identity WHERE external_id = %s", (phone,)
        ).fetchone()[0]
    assert "secret-Pass-9" not in secret
    assert secret.startswith("scrypt$")
