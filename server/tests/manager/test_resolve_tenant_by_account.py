"""员工账号 → tenant_id 解析测试（#382：去掉 Agent 端手工填 enterprise/tenant ID，自动关联企业）。"""

import uuid
from unittest.mock import MagicMock, patch

import pytest
from shared.db import PgTenantRouter


from shared.errors import NotFound

from manager_service.auth_service import AuthService, TenantSelectionRequired
from manager_service.keys import TenantKeyStore
from manager_service.repository import TenantAuthRepository


@pytest.fixture
def auth_svc(migrated_db: str, admin_url: str):
    """构造 AuthService（业务 DSN + 管理注入 admin_dsn）。"""
    return AuthService(
        dsn=migrated_db,
        repo=TenantAuthRepository(PgTenantRouter(migrated_db)),
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


@pytest.mark.integration
def test_resolve_by_phone_single_tenant(auth_svc, phone_with_tenant):
    """员工在唯一 tenant 中 → 自动解析到该 tenant_id。"""
    tid, phone = phone_with_tenant
    assert auth_svc.resolve_tenant_by_account(phone) == tid


@pytest.mark.integration
def test_resolve_not_bound_404(auth_svc):
    """账号未在任何 tenant 中 → 404。"""
    with pytest.raises(NotFound, match="account not bound to any tenant"):
        auth_svc.resolve_tenant_by_account("19900000000")


@pytest.mark.integration
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

    with pytest.raises(TenantSelectionRequired, match="account belongs to multiple tenants") as exc:
        auth_svc.resolve_tenant_by_account(phone)
    assert exc.value.status == 409
    assert exc.value.code == "tenant_selection_required"


@pytest.mark.integration
def test_resolve_prefers_phone_over_password(auth_svc, admin_url):
    """同一 tenant 既绑 provider=phone 又绑 provider=password（external_id 相同），
    应解析出该 tenant（不因重复重复计数导致 409）。
    """
    import psycopg

    from shared.contracts.enums import AuthProvider

    phone = "fixture-" + uuid.uuid4().hex
    tid = str(uuid.uuid4())
    slug = f"ent_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO tenant_registry (enterprise_slug, tenant_id) VALUES (%s, %s)",
            (slug, tid),
        )
    auth_svc.provision_owner(tid, phone=phone, bootstrap_password="Boot-Pass-3")

    # 同一 tenant 再加一条同名 external_id 的 password provider 身份
    from shared.contracts.tenancy import TenantContext
    ctx = TenantContext(tenant_id=tid, user_id="system", roles=["owner"])
    user_row = auth_svc._repo.find_identity(ctx, provider=AuthProvider.PHONE, external_id=phone)
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO auth_identity (tenant_id, user_id, provider, external_id, secret) "
            "VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING",
            (tid, user_row.user_id, AuthProvider.PASSWORD.value, phone, "x"),
        )

    assert auth_svc.resolve_tenant_by_account(phone) == tid


# ---------------------------------------------------------------------------
# Fast unit tests (no PG required): mock psycopg2 to exercise the scan/query path
# ---------------------------------------------------------------------------


def _svc():
    """In-process AuthService with fakes — admin URL not used when psycopg is mocked."""
    return AuthService(
        dsn="postgresql://f/f",
        repo=MagicMock(),
        keys=MagicMock(),
        admin_dsn="postgresql://admin/a",
    )


def _row(tid, status="active", slug=None):
    return (MagicMock(__str__=lambda self: tid), status, slug or f"slug-{tid}")


@patch("psycopg.connect")
def test_unit_enterprise_scopes_account_lookup(mock_connect):
    conn = MagicMock()
    conn.execute.return_value.fetchall.side_effect = [
        [("scoped-tenant", "active")],
        [("scoped-tenant", "active", "acme")],
    ]
    mock_connect.return_value.__enter__.return_value = conn
    assert _svc().resolve_tenant_by_account("13800000000", enterprise="acme") == "scoped-tenant"


@patch("psycopg.connect")
def test_unit_whitespace_enterprise_does_not_scope_account_lookup(mock_connect):
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = [("t-1", "active", "acme")]
    mock_connect.return_value.__enter__.return_value = conn
    svc = _svc()
    svc.resolve_tenant = MagicMock()
    assert svc.resolve_tenant_by_account("13800000000", enterprise="  ") == "t-1"
    svc.resolve_tenant.assert_not_called()
    sql, params = conn.execute.call_args[0]
    assert params == ("13800000000",)
    assert "ai.tenant_id = %s" not in sql
    assert "archived_at IS NULL" in sql


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
    assert exc_info.value.code == "tenant_selection_required"
    assert [c["tenant_id"] for c in exc_info.value.meta["candidates"]] == ["t-1", "t-2", "t-3"]


@patch("psycopg.connect")
def test_unit_resolve_prefers_active_over_inactive_tenant(mock_connect):
    """同号跨 active + 暂停 / 封禁企业：只解析到 active 企业，不再 409。"""
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = [_row("t-old", "suspended"), _row("t-new", "active")]
    mock_connect.return_value.__enter__.return_value = conn
    assert _svc().resolve_tenant_by_account("13800000000") == "t-new"


@patch("psycopg.connect")
def test_unit_resolve_only_inactive_tenant_still_resolves(mock_connect):
    """只在一个暂停企业里：照常解析，由登录给出“企业已暂停”的明确提示。"""
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = [_row("t-paused", "suspended")]
    mock_connect.return_value.__enter__.return_value = conn
    assert _svc().resolve_tenant_by_account("13800000000") == "t-paused"


@patch("psycopg.connect")
def test_unit_multi_active_candidates_exclude_inactive_and_sort_by_name(mock_connect):
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = [
        _row("t-b", "active", "乙企业"), _row("t-x", "banned", "封禁企业"), _row("t-a", "active", "aaa"),
    ]
    mock_connect.return_value.__enter__.return_value = conn
    with pytest.raises(TenantSelectionRequired) as exc:
        _svc().resolve_tenant_by_account("13800000000")
    assert exc.value.meta == {"candidates": [
        {"tenant_id": "t-a", "enterprise_name": "aaa"},
        {"tenant_id": "t-b", "enterprise_name": "乙企业"},
    ]}


@patch("psycopg.connect")
def test_unit_enterprise_code_shared_with_deleted_tenant_prefers_active(mock_connect):
    """企业代码在 purge 前仍被已删除企业占用：按代码解析只认 active 那家，不报歧义。"""
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = [("t-deleted", "deleted"), ("t-live", "active")]
    mock_connect.return_value.__enter__.return_value = conn
    assert _svc().resolve_tenant("ACME") == "t-live"


# ---------------------------------------------------------------------------
# 真库：企业生命周期 × 账号解析（缺陷记录 2026-11-25「登录企业解析缺陷」回归）
# ---------------------------------------------------------------------------


def _tenant_with_phone(auth_svc, admin_url, phone, *, slug=None):
    import psycopg

    tid = str(uuid.uuid4())
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO tenant_registry (enterprise_slug, tenant_id) VALUES (%s, %s)",
            (slug or f"ent_{uuid.uuid4().hex[:8]}", tid),
        )
    auth_svc.provision_owner(tid, phone=phone, bootstrap_password="Boot-Pass-2")
    return tid


def _new_phone():
    return f"1{uuid.uuid4().int % 10_000_000_000:010d}"


@pytest.mark.integration
@pytest.mark.parametrize("status", ["deleted", "closed"])
def test_resolve_ignores_closed_or_deleted_tenant_after_status_change(auth_svc, admin_url, status):
    """同号跨 active + 注销/删除企业：状态下发后身份归档，解析只返回 active 企业。"""
    from manager_service.tenant_status import TenantStatusStore

    phone = _new_phone()
    old = _tenant_with_phone(auth_svc, admin_url, phone)
    live = _tenant_with_phone(auth_svc, admin_url, phone)
    with pytest.raises(TenantSelectionRequired):
        auth_svc.resolve_tenant_by_account(phone)

    TenantStatusStore(admin_url).set_status(old, status, "test")
    assert auth_svc.resolve_tenant_by_account(phone) == live


@pytest.mark.integration
def test_deleted_tenant_identity_no_longer_resolves_and_restore_unarchives(auth_svc, admin_url):
    """企业删除后：该企业身份不再参与解析；企业恢复后重新可解析。"""
    import psycopg

    from manager_service.tenant_status import TenantStatusStore

    phone = _new_phone()
    tid = _tenant_with_phone(auth_svc, admin_url, phone)
    store = TenantStatusStore(admin_url)
    store.set_status(tid, "deleted", "test")
    with psycopg.connect(admin_url, autocommit=True) as conn:
        archived = conn.execute(
            "SELECT count(*) FROM auth_identity WHERE tenant_id = %s AND archived_at IS NOT NULL", (tid,),
        ).fetchone()[0]
    assert archived >= 1
    with pytest.raises(NotFound):
        auth_svc.resolve_tenant_by_account(phone)

    store.set_status(tid, "active", None)
    assert auth_svc.resolve_tenant_by_account(phone) == tid


@pytest.mark.integration
def test_suspended_tenant_is_not_archived(auth_svc, admin_url):
    """暂停可恢复且需要明确提示：不归档，仍可解析。"""
    from manager_service.tenant_status import TenantStatusStore

    phone = _new_phone()
    tid = _tenant_with_phone(auth_svc, admin_url, phone)
    TenantStatusStore(admin_url).set_status(tid, "suspended", "test")
    assert auth_svc.resolve_tenant_by_account(phone) == tid


@pytest.mark.integration
def test_two_active_tenants_return_candidates(auth_svc, admin_url):
    """同号跨两个 active 企业：409 带候选企业，带 enterprise 后可继续。"""
    phone = _new_phone()
    slug_a, slug_b = f"a_{uuid.uuid4().hex[:8]}", f"b_{uuid.uuid4().hex[:8]}"
    tid_a = _tenant_with_phone(auth_svc, admin_url, phone, slug=slug_a)
    tid_b = _tenant_with_phone(auth_svc, admin_url, phone, slug=slug_b)
    with pytest.raises(TenantSelectionRequired) as exc:
        auth_svc.resolve_tenant_by_account(phone)
    assert exc.value.meta == {"candidates": [
        {"tenant_id": tid_a, "enterprise_name": slug_a},
        {"tenant_id": tid_b, "enterprise_name": slug_b},
    ]}
    assert auth_svc.resolve_tenant_by_account(phone, enterprise=slug_b) == tid_b
