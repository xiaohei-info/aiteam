"""Review 修复补充：删除相关的仓储 SQL、令牌吊销、补同步命令与目录范围路由（不依赖真实 PG）。"""

from __future__ import annotations

from contextlib import contextmanager, nullcontext
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from operation_service.admin_repository import _next_operation_status
from shared.errors import InvalidTransition, NotFound

ENT = "11111111-1111-4111-8111-111111111111"
TENANT = "22222222-2222-4222-8222-222222222222"
_ACCOUNT_ROW = (ENT, TENANT, "Acme", "acme", "138", "hash", None, "制造业", ["KA"])


class _Cur:
    def __init__(self, conn):
        self._conn = conn
        self._result: dict = {}
        self.rowcount = 1

    def execute(self, sql, params=()):
        self._result = self._conn.run(sql, params)
        self.rowcount = self._result.get("rowcount", 1)
        return self

    def fetchone(self):
        return self._result.get("one")

    def fetchall(self):
        return self._result.get("all", [])

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Conn:
    """同时支持 conn.cursor().execute 与 conn.execute；按 SQL 文本给结果。"""

    def __init__(self, handler):
        self.handler, self.calls, self.committed = handler, [], False

    def run(self, sql, params):
        self.calls.append((sql, params))
        return self.handler(sql, params) or {}

    def cursor(self):
        return _Cur(self)

    def execute(self, sql, params=()):
        cur = _Cur(self)
        return cur.execute(sql, params)

    def transaction(self):
        return nullcontext()

    def commit(self):
        self.committed = True

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _account_lookup(sql, params):
    if "FROM enterprise_account" in sql and sql.lstrip().startswith("SELECT enterprise_id"):
        return {"one": _ACCOUNT_ROW}
    return None


# ---- 生命周期动作 ----

@pytest.mark.parametrize("current", ["deleting", "deleted"])
@pytest.mark.parametrize("action", ["reactivate", "suspend", "ban", "close"])
def test_no_lifecycle_action_applies_to_an_enterprise_being_deleted(current, action):
    with pytest.raises(InvalidTransition):
        _next_operation_status(current, action)


# ---- PgEnterpriseRepository ----

def _pg_repo():
    from operation_service.repository import PgEnterpriseRepository

    return PgEnterpriseRepository("postgresql://test")


def test_pg_update_profile_writes_and_reports_missing_enterprise():
    conn = _Conn(lambda sql, params: _account_lookup(sql, params) or {"rowcount": 1})
    with patch("psycopg.connect", return_value=conn):
        account = _pg_repo().update_profile(ENT, industry="制造业", tags=["KA"])
    assert account.industry == "制造业" and list(account.tags) == ["KA"]
    update = next(params for sql, params in conn.calls if sql.startswith("UPDATE enterprise_account SET industry"))
    assert update == ("制造业", ["KA"], ENT)

    missing = _Conn(lambda sql, params: {"rowcount": 0})
    with patch("psycopg.connect", return_value=missing), pytest.raises(NotFound):
        _pg_repo().update_profile("nope", industry=None, tags=[])


def test_pg_list_profiles_skips_deleted_enterprises():
    conn = _Conn(lambda sql, params: {"all": [("制造业", ["KA"]), (None, None)]})
    with patch("psycopg.connect", return_value=conn):
        assert _pg_repo().list_profiles() == [("制造业", ("KA",)), (None, ())]
    assert "operation_status <> 'deleted'" in conn.calls[0][0]


def test_pg_operation_status_by_tenant():
    with patch("psycopg.connect", return_value=_Conn(lambda sql, params: {"one": ("suspended",)})):
        assert _pg_repo().operation_status(TENANT) == "suspended"
    with patch("psycopg.connect", return_value=_Conn(lambda sql, params: {"one": None})):
        assert _pg_repo().operation_status(TENANT) is None


def test_pg_anonymize_clears_account_and_onboarding_receipts_in_one_transaction():
    conn = _Conn(_account_lookup)
    with patch("psycopg.connect", return_value=conn):
        _pg_repo().anonymize(ENT)
    writes = [(sql, params) for sql, params in conn.calls if sql.startswith("UPDATE")]
    assert [sql.split(" SET ")[0] for sql, _ in writes] == ["UPDATE enterprise_account", "UPDATE onboarding_receipt"]
    code = f"deleted-{TENANT}"
    assert all(params == (code, ENT) for _, params in writes)
    receipt_sql = writes[1][0]
    assert "owner_phone = ''" in receipt_sql and "bootstrap_secret_ciphertext = NULL" in receipt_sql
    assert "request_body = '{}'::jsonb" in receipt_sql and conn.committed


def test_in_memory_anonymize_releases_the_enterprise_code():
    from operation_service.repository import EnterpriseAccount, InMemoryEnterpriseRepository

    repo = InMemoryEnterpriseRepository()
    repo.create(EnterpriseAccount(
        enterprise_id=ENT, tenant_id=TENANT, enterprise_name="Acme", enterprise_code="acme",
        owner_phone="138", owner_bootstrap_hash="h",
    ))
    repo.anonymize(ENT)
    assert repo.get(ENT).enterprise_code == f"deleted-{TENANT}"
    # 旧代码已释放，新企业可以再用
    repo.create(EnterpriseAccount(
        enterprise_id="33333333-3333-4333-8333-333333333333", tenant_id="44444444-4444-4444-8444-444444444444",
        enterprise_name="New", enterprise_code="acme", owner_phone="139", owner_bootstrap_hash="h",
    ))


def test_pg_mark_purged_sets_the_timestamp():
    from operation_service.admin_repository import PgAdminRepository

    state_row = (ENT, "已删除企业", "", "deleted", 0, None, None, None, None, None, None, None, "2026-11-13")

    def handler(sql, params):
        if sql.startswith("SELECT"):
            return {"one": state_row}
        return None

    conn = _Conn(handler)
    from datetime import UTC, datetime

    at = datetime(2026, 11, 13, tzinfo=UTC)
    state_row = state_row[:5] + (at,) + state_row[6:]
    with patch("psycopg.connect", return_value=conn):
        state = PgAdminRepository("postgresql://test").mark_purged(ENT, at)
    assert conn.calls[0][0].startswith("UPDATE enterprise_account SET purged_at") and conn.calls[0][1] == (at, ENT)
    assert state.purged_at == "2026-11-13"


# ---- 吊销中转令牌 ----

def _provider_service(repo, enterprise=None):
    from operation_service.platform_provider_service import PlatformProviderService

    crypto = SimpleNamespace(encrypt=lambda v: v.encode(), decrypt=lambda v: v.decode())
    return PlatformProviderService(
        repo, None, crypto, "http://relay/v1", enterprise_repository=enterprise,  # type: ignore[arg-type]
    )


class _ProviderRepo:
    def __init__(self, accesses, *, locks=True):
        self.accesses, self.lock_log = accesses, []
        if locks:
            self.relay_policy_lock = self._policy_lock
            self.relay_access_lock = self._access_lock

    @contextmanager
    def _policy_lock(self, tenant_id):
        self.lock_log.append(("policy", tenant_id))
        yield

    @contextmanager
    def _access_lock(self, tenant_id, provider_id):
        self.lock_log.append(("access", tenant_id, provider_id))
        yield

    def get_access(self, tenant_id, provider_id):
        return self.accesses.get(provider_id)


@pytest.mark.parametrize("locks", [True, False])
def test_revoke_tenant_access_revokes_only_active_tokens_under_locks(monkeypatch, locks):
    repo = _ProviderRepo({
        "p1": SimpleNamespace(status="active"), "p2": SimpleNamespace(status="revoked"), "p3": None,
    }, locks=locks)
    service = _provider_service(repo)
    revoked = []
    monkeypatch.setattr(service, "list_providers", lambda: [SimpleNamespace(provider_id=p) for p in ("p1", "p2", "p3")])
    monkeypatch.setattr(service, "_revoke_existing_access",
                        lambda existing, **kw: revoked.append((kw["provider_id"], kw["desired_model_ids"])))
    service.revoke_tenant_access(TENANT)
    assert revoked == [("p1", [])]
    if locks:
        assert repo.lock_log[:2] == [("policy", TENANT), ("access", TENANT, "p1")]
    else:
        assert repo.lock_log == []


def test_inactive_enterprise_gets_no_model_access():
    enterprise = SimpleNamespace(
        get_by_tenant_id=lambda tenant_id: SimpleNamespace(allowed_model_refs=[{"provider_id": "p1", "model_id": "m1"}]),
        operation_status=lambda tenant_id: "suspended",
    )
    service = _provider_service(_ProviderRepo({}), enterprise)
    assert service._allowed_model_refs(TENANT) == []
    enterprise.operation_status = lambda tenant_id: "active"
    assert service._allowed_model_refs(TENANT) == [{"provider_id": "p1", "model_id": "m1"}]


def test_admin_relay_access_is_optional_when_the_relay_is_not_configured(monkeypatch):
    from operation_service import admin_dependencies, platform_provider_service

    def unconfigured():
        raise RuntimeError("NEWAPI_URL is not configured")

    monkeypatch.setattr(platform_provider_service, "build_platform_provider_service", unconfigured)
    assert admin_dependencies._relay_access() is None
    sentinel = object()
    monkeypatch.setattr(platform_provider_service, "build_platform_provider_service", lambda: sentinel)
    assert admin_dependencies._relay_access() is sentinel


# ---- 补同步命令 ----

def test_resync_command_prints_result_and_exits_nonzero_on_failures(monkeypatch, capsys):
    from operation_service import tenant_status_resync

    result = {"synced": 2, "failed": []}
    monkeypatch.setattr(tenant_status_resync, "get_admin_service",
                        lambda: SimpleNamespace(resync_tenant_statuses=lambda: result))
    assert tenant_status_resync.main([]) == 0
    assert '"synced": 2' in capsys.readouterr().out
    result = {"synced": 1, "failed": [{"enterprise_id": ENT, "error": "manager down"}]}
    assert tenant_status_resync.main([]) == 1


# ---- 删除流程的边界 ----

def test_purge_still_blocks_on_a_generic_not_found_from_manager():
    """旧版 Manager 没有清理路由时返回通用 not_found，不能当作“无此租户”而继续匿名化。"""
    from operation_service.admin_repository import AdminRepository
    from operation_service.admin_service import AdminService
    from operation_service.catalog_repository import CatalogRepository
    from operation_service.repository import EnterpriseAccount, InMemoryEnterpriseRepository
    from operation_service.rollup_repository import CrossEnterpriseRollupRepository
    from tests.operation.test_admin_service import FakeManagerGateway

    from datetime import UTC, datetime

    now = datetime(2026, 11, 13, tzinfo=UTC)
    enterprises = InMemoryEnterpriseRepository()
    enterprises.create(EnterpriseAccount(
        enterprise_id=ENT, tenant_id=TENANT, enterprise_name="Acme", enterprise_code=None,
        owner_phone="138", owner_bootstrap_hash="h",
    ))
    admin = AdminRepository()

    class Gateway(FakeManagerGateway):
        def purge_tenant(self, tenant_id, *, idempotency_key):
            raise NotFound("route not found")

    svc = AdminService(admin, enterprises, CatalogRepository(), CrossEnterpriseRollupRepository(),
                       manager_gateway=Gateway(), clock=lambda: now)
    svc._ensure_state(ENT)
    for status in ("closed", "deleting", "deleted"):
        admin.set_operation_status(ENT, status, normalized=True, at=now - timedelta(days=31))
    with pytest.raises(NotFound):
        svc.purge(ENT)
    assert enterprises.get(ENT).enterprise_name == "Acme"  # 没有匿名化
    assert svc._tenant_id("99999999-9999-4999-8999-999999999999") is None


# ---- 目录：发布范围 ----

def test_scope_is_closed_without_enterprise_data_and_missing_experts_are_left_to_the_package_check():
    from operation_service.catalog_repository import CatalogRepository
    from operation_service.catalog_service import CatalogService

    from tests.operation.test_catalog_routes import FakeCatalogGateway

    service = CatalogService(CatalogRepository(), FakeCatalogGateway())
    limited = SimpleNamespace(visible_scope={"mode": "limited", "industries": ["零售"], "tags": []})
    assert service._visible_to(limited, TENANT) is False  # type: ignore[arg-type]  # 没有企业资料来源：按不可见
    assert service._expert_visible("missing-template", TENANT) is True
