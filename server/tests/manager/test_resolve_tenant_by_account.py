"""员工账号 → tenant_id 解析测试（#382：去掉 Agent 端手工填 enterprise/tenant ID，自动关联企业）。"""

import uuid

import pytest

from shared.errors import Conflict, NotFound

from manager_service.auth_service import AuthService
from manager_service.keys import TenantKeyStore
from manager_service.repository import TenantAuthRepository


@pytest.fixture
def auth_svc(migrated_db: str, admin_url: str):
    """构造 AuthService（业务 DSN + 管理注入 admin_dsn）。"""
    return AuthService(
        dsn=migrated_db,
        repo=TenantAuthRepository(),
        keys=TenantKeyStore(admin_url),
        admin_dsn=admin_url,
    )


@pytest.fixture
def phone_with_tenant(auth_svc, admin_url):
    """建一个绑定了 phone 账号的测试租户，返回 (tenant_id, phone)。"""
    import psycopg

    tid = str(uuid.uuid4())
    phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    slug = f"ent_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO tenant_registry (enterprise_slug, tenant_id) VALUES (%s, %s)",
            (slug, tid),
        )
    auth_svc.provision_owner(tid, phone=phone, bootstrap_password="Boot-Pass-1")
    return tid, phone


def test_resolve_by_phone_single_tenant(auth_svc, phone_with_tenant):
    """员工在唯一 tenant 中 → 自动解析到该 tenant_id。"""
    tid, phone = phone_with_tenant
    assert auth_svc.resolve_tenant_by_account(phone) == tid


def test_resolve_not_bound_404(auth_svc):
    """账号未在任何 tenant 中 → 404。"""
    with pytest.raises(NotFound, match="account not bound to any tenant"):
        auth_svc.resolve_tenant_by_account("19900000000")


def test_resolve_multiple_tenants_409(auth_svc, admin_url):
    """员工同时属于多个 tenant → 409（由调用方要求用户明确企业）。"""
    import psycopg

    phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    tids = []
    for _ in range(2):
        tid = str(uuid.uuid4())
        slug = f"ent_{uuid.uuid4().hex[:8]}"
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute(
                "INSERT INTO tenant_registry (enterprise_slug, tenant_id) VALUES (%s, %s)",
                (slug, tid),
            )
        auth_svc.provision_owner(tid, phone=phone, bootstrap_password="Boot-Pass-2")
        tids.append(tid)

    with pytest.raises(Conflict, match="account belongs to multiple tenants"):
        auth_svc.resolve_tenant_by_account(phone)


def test_resolve_prefers_phone_over_password(auth_svc, admin_url):
    """同一 tenant 既绑 provider=phone 又绑 provider=password（external_id 相同），
    应解析出该 tenant（不因重复重复计数导致 409）。
    """
    import psycopg

    from shared.contracts.enums import AuthProvider

    tid = str(uuid.uuid4())
    slug = f"ent_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO tenant_registry (enterprise_slug, tenant_id) VALUES (%s, %s)",
            (slug, tid),
        )
    auth_svc.provision_owner(tid, phone="13800000000", bootstrap_password="Boot-Pass-3")

    # 同一 tenant 再加一条同名 external_id 的 password provider 身份
    from shared.contracts.tenancy import TenantContext
    ctx = TenantContext(tenant_id=tid, user_id="system", roles=["owner"])
    from manager_service.security import hash_password
    user_row = auth_svc._repo.find_identity(ctx, provider=AuthProvider.PHONE, external_id="13800000000")
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO auth_identity (tenant_id, user_id, provider, external_id, secret) "
            "VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING",
            (tid, user_row.user_id, AuthProvider.PASSWORD.value, "13800000000", "x"),
        )

    assert auth_svc.resolve_tenant_by_account("13800000000") == tid


# ---------------------------------------------------------------------------
# Fast unit tests (no PG required): mock psycopg2 to exercise the scan/query path
# ---------------------------------------------------------------------------
from unittest.mock import MagicMock, patch

import pytest

from manager_service.auth_service import AuthService


def _svc():
    """In-process AuthService with fakes — admin URL not used when psycopg is mocked."""
    return AuthService(dsn="postgresql://f/f", repo=MagicMock(), keys=MagicMock(), admin_dsn="postgresql://admin/a")


def _row(tid):
    return (MagicMock(__str__=lambda self: tid),)


@patch("psycopg.connect")
def test_unit_resolve_single_hit(mock_connect):
    """provider IN (...) 命中唯一 tenant → 返回 tenant_id。"""
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = [_row("t-1")]
    mock_connect.return_value.__enter__.return_value = conn

    assert _svc().resolve_tenant_by_account("13800000000") == "t-1"
    mock_connect.assert_called_once_with("postgresql://admin/a", autocommit=True)


@patch("psycopg.connect")
def test_unit_resolve_phone_and_password_rows_same_tenant_dedup(mock_connect):
    """同一 tenant 有多条 provider=phone/password 行时应去重为一个 tenant，不会误触 409。"""
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = [_row("t-1"), _row("t-1")]
    mock_connect.return_value.__enter__.return_value = conn

    assert _svc().resolve_tenant_by_account("13800000000") == "t-1"


@patch("psycopg.connect")
def test_unit_resolve_zero_hit_raises_not_found(mock_connect):
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = []
    mock_connect.return_value.__enter__.return_value = conn

    with pytest.raises(Exception) as exc_info:
        _svc().resolve_tenant_by_account("13800000000")
    # 404 NotFound
    assert exc_info.value.status == 404


@patch("psycopg.connect")
def test_unit_resolve_multi_tenant_raises_conflict(mock_connect):
    """多个不同 tenant 命中同一账号 → 409。"""
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = [_row("t-1"), _row("t-2"), _row("t-3")]
    mock_connect.return_value.__enter__.return_value = conn

    with pytest.raises(Exception) as exc_info:
        _svc().resolve_tenant_by_account("13800000000")
    assert exc_info.value.status == 409
