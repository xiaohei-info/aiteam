"""PR #198 第 2 轮复审：复制路由不阻塞事件循环、0052 灰度修正、企业不可用时先拒绝再写、暂停企业不对账、清理后不能重建负责人。"""

from __future__ import annotations

import inspect
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from manager_service import catalog_scope_wiring
from manager_service.auth_service import AuthService
from manager_service.repository import IdentityRow
from manager_service.security import hash_password
from manager_service.tenant_status import TenantUnavailable
from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict

TENANT = "11111111-1111-4111-8111-111111111111"
USER = "22222222-2222-4222-8222-222222222222"
PHONE = "13800000000"
OLD = "Old-Passw0rd!"
NEW = "New-Passw0rd!"
MIGRATIONS = Path(__file__).resolve().parents[2] / "manager_service" / "migrations"


def test_copy_route_runs_in_the_threadpool():
    """复制会同步读库、调运营端目录、复制头像文件：必须是普通函数，由框架放到线程池。"""
    from manager_service.routes_employee import build_employee_router
    from tests.manager._auth_helper import make_inmem_verifier_and_signer

    verifier, _ = make_inmem_verifier_and_signer()
    from fastapi.routing import APIRoute

    routes = build_employee_router(verifier).routes
    [route] = [r for r in routes if isinstance(r, APIRoute) and r.path.endswith("/copy")]
    assert not inspect.iscoroutinefunction(route.endpoint)


def test_0052_corrects_custom_experts_created_during_rollout_on_every_run():
    """迁移先于新代码上线：旧代码新建的自建专家拿到列默认值 recruited，每次部署都要修正。"""
    sql = (MIGRATIONS / "0052_employee_origin.sql").read_text(encoding="utf-8")
    after_do = sql.split("END $$;", 1)[1]
    assert "UPDATE employee SET origin = 'custom' WHERE origin = 'recruited' AND source_template_id IS NULL;" in after_do


class _Repo:
    def __init__(self):
        self.row = IdentityRow(
            identity_id="i1", user_id=USER, secret=hash_password(OLD), must_reset=False,
            password_changed_at=None, roles=["owner"], status="active",
        )
        self.updated = []

    def find_identity(self, ctx, *, provider, external_id):
        return self.row

    def find_user(self, ctx, *, user_id):
        return self.row

    def update_secret(self, ctx, **kw):
        self.updated.append(kw)


class _Audit:
    def __init__(self):
        self.records = []

    def record(self, ctx, **kw):
        self.records.append(kw)


class _Sessions:
    def __init__(self):
        self.revoked = []

    def revoke_user(self, ctx, *, reason):
        self.revoked.append(reason)


@pytest.fixture
def suspended(monkeypatch):
    monkeypatch.setattr("manager_service.tenant_status.fetch_tenant_status", lambda dsn, tid: "suspended")


def _auth():
    repo, audit, sessions = _Repo(), _Audit(), _Sessions()
    return AuthService(dsn="postgresql://biz", repo=repo, keys=None, audit=audit, sessions=sessions), repo, audit, sessions


def test_login_to_a_suspended_tenant_is_rejected_before_a_success_audit(suspended):
    svc, _, audit, _ = _auth()
    with pytest.raises(TenantUnavailable):
        svc.login(SimpleNamespace(tenant_id=TENANT, enterprise=None, account=PHONE, password=OLD))
    assert not any(r["success"] for r in audit.records)


def test_owner_reset_on_a_suspended_tenant_changes_nothing(suspended):
    svc, repo, audit, sessions = _auth()
    req = SimpleNamespace(tenant_id=TENANT, enterprise=None, account=PHONE, old_password=OLD, new_password=NEW)
    with pytest.raises(TenantUnavailable):
        svc.owner_reset(req)
    assert repo.updated == [] and sessions.revoked == []
    assert not any(r["success"] for r in audit.records)


def test_owner_reset_wrong_password_does_not_reveal_tenant_status(suspended):
    svc, *_ = _auth()
    req = SimpleNamespace(tenant_id=TENANT, enterprise=None, account=PHONE, old_password="Wrong-Passw0rd!", new_password=NEW)
    from shared.errors import Unauthorized

    with pytest.raises(Unauthorized):
        svc.owner_reset(req)


def _request(status):
    state = SimpleNamespace(
        settings=SimpleNamespace(db_url="postgresql://biz", admin_db_url="postgresql://admin"),
        _operator_catalog=object(), _tenant_status_store=SimpleNamespace(get=lambda tid: status),
    )
    return SimpleNamespace(app=SimpleNamespace(state=state))


@pytest.mark.parametrize("status", ["suspended", "banned", "closed", "deleted"])
def test_reconcile_on_read_skips_unavailable_tenants(monkeypatch, status):
    """对账会写员工状态并发通知；企业不可用（含暂停只读）时不做。"""
    monkeypatch.setattr(catalog_scope_wiring, "build_reconciler", lambda request: pytest.fail("must not reconcile"))
    ctx = TenantContext(tenant_id=TENANT, user_id="u1", roles=["owner"])
    catalog_scope_wiring.reconcile_for_admin(_request(status), ctx)  # type: ignore[arg-type]


def test_reconcile_on_read_runs_for_active_tenants(monkeypatch):
    calls = []
    monkeypatch.setattr(
        catalog_scope_wiring, "build_reconciler",
        lambda request: SimpleNamespace(reconcile=lambda ctx, visible_ids=None: calls.append(ctx.tenant_id)),
    )
    ctx = TenantContext(tenant_id=TENANT, user_id="u1", roles=["owner"])
    catalog_scope_wiring.reconcile_for_admin(_request("active"), ctx)  # type: ignore[arg-type]
    assert calls == [TENANT]


def _registry_row(row):
    conn = MagicMock()
    conn.__enter__.return_value = conn
    conn.execute.return_value.fetchone.return_value = row
    return patch("psycopg.connect", return_value=conn)


@pytest.mark.parametrize("row", [("closed", None), ("deleted", None), ("active", "2026-11-01")])
def test_owner_bootstrap_refuses_closed_deleted_or_purged_tenants(row):
    """清理后 tenant_registry 仍在：不能在已清理 / 已注销 / 已删除的租户里重建负责人账号。"""
    from manager_service.routes_bootstrap import _tenant_exists

    with _registry_row(row), pytest.raises(Conflict):
        _tenant_exists("postgresql://admin", TENANT)


@pytest.mark.parametrize(("row", "expected"), [(("active", None), True), (("suspended", None), True), (None, False)])
def test_owner_bootstrap_allows_live_tenants(row, expected):
    from manager_service.routes_bootstrap import _tenant_exists

    with _registry_row(row):
        assert _tenant_exists("postgresql://admin", TENANT) is expected
