"""R5：租户状态入口拦截、状态/清理路由、清理的依赖顺序（无 DB；真实 PG 清理由 CI 集成测试覆盖）。"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from manager_service.service_ingress import canonical_body_sha256, require_operator_service_principal
from manager_service.tenant_status import (
    TenantStatusStore, TenantUnavailable, check_access, delete_in_dependency_order,
    install_tenant_status_guard,
)
from shared.config import Settings
from shared.errors import Conflict, ServiceUnavailable

T = "11111111-1111-4111-8111-111111111111"


@pytest.mark.parametrize("status,method,path,code", [
    ("suspended", "POST", "/api/manager/employees", "tenant_suspended"),
    ("suspended", "DELETE", "/api/manager/employees/x", "tenant_suspended"),
    ("banned", "GET", "/api/manager/employees", "tenant_banned"),
    ("closed", "GET", "/api/manager/employees", "tenant_closed"),
    ("deleted", "GET", "/api/manager/employees", "tenant_deleted"),
])
def test_blocked_requests(status, method, path, code):
    with pytest.raises(TenantUnavailable) as exc:
        check_access(status, method, path)
    assert exc.value.code == code and exc.value.status == 403


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/manager/employees"), ("HEAD", "/api/manager/employees"),
    ("POST", "/api/auth/logout"), ("POST", "/api/manager/usage/upload"),
    ("POST", "/api/manager/usage/segment-outcomes"), ("POST", "/api/manager/snapshots"),
])
def test_suspended_allows_reads_and_whitelisted_writes(method, path):
    check_access("suspended", method, path)


def test_active_and_unknown_status_pass():
    check_access("active", "POST", "/x")
    check_access("weird", "POST", "/x")


def test_store_caches_for_ttl_then_refetches_and_survives_outage():
    now = [0.0]
    calls = []
    state = {"fail": False, "value": "active"}

    def fetch(dsn, tenant):
        calls.append(tenant)
        if state["fail"]:
            raise ServiceUnavailable("db down")
        return state["value"]

    store = TenantStatusStore("dsn", ttl=5, clock=lambda: now[0], fetch=fetch)
    assert store.get(T) == "active" and store.get(T) == "active" and len(calls) == 1
    state["value"] = "suspended"
    now[0] = 6
    assert store.get(T) == "suspended" and len(calls) == 2
    state["fail"] = True
    now[0] = 12
    assert store.get(T) == "suspended"  # 控制库短暂不可用：沿用上次结果
    with pytest.raises(ServiceUnavailable):
        TenantStatusStore("dsn", fetch=fetch).get("other")  # 没有缓存则失败关闭


def _guarded_app(status, claims_tenant=T):
    app = FastAPI()
    app.state._token_verifier = SimpleNamespace(
        verify=lambda token: (_ for _ in ()).throw(ValueError("bad")) if token == "bad" else SimpleNamespace(tenant_id=claims_tenant),
    )
    app.state._tenant_status_store = SimpleNamespace(get=lambda tenant: status)
    install_tenant_status_guard(app)

    @app.get("/api/x")
    def get_x():
        return {"ok": True}

    @app.post("/api/x")
    def post_x():
        return {"ok": True}

    @app.get("/other")
    def other():
        return {"ok": True}

    return TestClient(app)


def test_guard_blocks_suspended_writes_but_not_reads():
    client = _guarded_app("suspended")
    auth = {"Authorization": "Bearer good"}
    assert client.get("/api/x", headers=auth).status_code == 200
    r = client.post("/api/x", headers=auth)
    assert r.status_code == 403 and r.json()["code"] == "tenant_suspended"
    assert r.headers["content-type"].startswith("application/problem+json")


@pytest.mark.parametrize("status", ["banned", "closed", "deleted"])
def test_guard_blocks_everything_for_terminal_states(status):
    client = _guarded_app(status)
    r = client.get("/api/x", headers={"Authorization": "Bearer good"})
    assert r.status_code == 403 and r.json()["code"] == f"tenant_{status}"


def test_guard_does_not_leak_status_for_invalid_tokens_or_non_api_paths():
    client = _guarded_app("deleted")
    assert client.get("/api/x", headers={"Authorization": "Bearer bad"}).status_code == 200  # 交由路由判 401
    assert client.get("/api/x").status_code == 200
    assert client.get("/other", headers={"Authorization": "Bearer good"}).status_code == 200


def test_delete_in_dependency_order_retries_blocked_tables():
    order = []
    deleted = set()
    deps = {"parent": {"child"}}  # parent 要等 child 先删

    def try_delete(table):
        if deps.get(table, set()) - deleted:
            return False
        deleted.add(table)
        order.append(table)
        return True

    delete_in_dependency_order(["parent", "child", "solo"], try_delete)
    assert order.index("child") < order.index("parent") and set(order) == {"parent", "child", "solo"}


def test_delete_in_dependency_order_reports_cycles():
    with pytest.raises(Conflict) as exc:
        delete_in_dependency_order(["a", "b"], lambda table: False)
    assert "a" in str(exc.value) and "b" in str(exc.value)


# ---- 路由 ----

class FakeStore:
    def __init__(self, record):
        self.rec, self.set_calls, self.invalidated = record, [], []

    def record(self, tenant):
        return self.rec

    def set_status(self, tenant, status, reason):
        self.set_calls.append((tenant, status, reason))
        return True

    def invalidate(self, tenant):
        self.invalidated.append(tenant)


def _route_client(store, body, path, *, tenant=T):
    from manager_service.app import router as manager_router
    from manager_service.routes_tenant import router as tenant_router
    from shared.app_factory import create_app

    app = create_app(Settings(tier="manager", service_name="m", admin_db_url="postgresql://x/x"), manager_router)
    app.state._tenant_status_store = store
    app.include_router(tenant_router)
    principal = SimpleNamespace(
        purpose="service", scope=("tenant:lifecycle",), capability="tenant-lifecycle", kid="k1",
        enterprise_id=None, tenant_id=tenant, path=path, idempotency_key="idem-1",
        body_sha256=canonical_body_sha256(body),
    )
    app.dependency_overrides[require_operator_service_principal] = lambda: principal
    return TestClient(app)


def test_status_route_sets_status():
    store = FakeStore(("active", None))
    path = f"/api/manager/tenants/{T}/status"
    client = _route_client(store, {"status": "suspended", "reason": "欠费"}, path)
    r = client.post(path, json={"status": "suspended", "reason": "欠费"}, headers={"Idempotency-Key": "idem-1"})
    assert r.status_code == 200 and r.json()["data"] == {"tenant_id": T, "status": "suspended"}
    assert store.set_calls == [(T, "suspended", "欠费")]


def test_status_route_rejects_unknown_tenant_purged_tenant_and_bad_status_and_missing_key():
    path = f"/api/manager/tenants/{T}/status"
    body = {"status": "closed"}
    hdr = {"Idempotency-Key": "idem-1"}
    assert _route_client(FakeStore(None), body, path).post(path, json=body, headers=hdr).status_code == 404
    purged = _route_client(FakeStore(("deleted", "2026-01-01")), body, path)
    assert purged.post(path, json=body, headers=hdr).status_code == 409
    ok = _route_client(FakeStore(("active", None)), body, path)
    assert ok.post(path, json={"status": "nope"}, headers=hdr).status_code == 422
    assert ok.post(path, json=body).status_code in (403, 422)  # 缺幂等键


def test_status_route_rejects_principal_for_another_tenant():
    path = f"/api/manager/tenants/{T}/status"
    body = {"status": "closed"}
    client = _route_client(FakeStore(("active", None)), body, path, tenant="22222222-2222-4222-8222-222222222222")
    assert client.post(path, json=body, headers={"Idempotency-Key": "idem-1"}).status_code == 403


def test_purge_route_only_for_deleted_tenants(monkeypatch):
    purged = []
    monkeypatch.setattr("manager_service.tenant_status.purge_tenant_data",
                        lambda dsn, tenant, root: purged.append(tenant) or {"employee": 3, "app_user": 2})
    monkeypatch.setattr("manager_service.knowledge_intake_service.manager_storage_root", lambda settings: None)
    path = f"/api/manager/tenants/{T}/purge"
    hdr = {"Idempotency-Key": "idem-1"}
    active = _route_client(FakeStore(("active", None)), {}, path)
    assert active.post(path, json={}, headers=hdr).status_code == 409 and purged == []
    assert _route_client(FakeStore(None), {}, path).post(path, json={}, headers=hdr).status_code == 404
    store = FakeStore(("deleted", None))
    r = _route_client(store, {}, path).post(path, json={}, headers=hdr)
    assert r.status_code == 200 and r.json()["data"]["purged_rows"] == 5
    assert purged == [T] and store.invalidated == [T]


# ---- 健壮性：拦截不阻塞事件循环、带 request_id；租户不存在有专用错误码；文件删除失败要留痕 ----

def test_guard_reads_status_off_the_event_loop_and_keeps_request_id():
    import asyncio

    from shared.observability import RequestContextMiddleware

    seen = {}

    def get(tenant):
        try:
            asyncio.get_running_loop()
            seen["on_loop"] = True
        except RuntimeError:
            seen["on_loop"] = False
        return "banned"

    app = FastAPI()
    app.add_middleware(RequestContextMiddleware)
    app.state._token_verifier = SimpleNamespace(verify=lambda token: SimpleNamespace(tenant_id=T))
    app.state._tenant_status_store = SimpleNamespace(get=get)
    install_tenant_status_guard(app)

    @app.get("/api/x")
    def get_x():
        return {"ok": True}

    r = TestClient(app).get("/api/x", headers={"Authorization": "Bearer good"})
    assert r.status_code == 403 and r.json()["code"] == "tenant_banned"
    assert seen == {"on_loop": False}  # 同步读库放在线程池，不占事件循环
    assert r.headers.get("x-request-id") and r.json()["request_id"] == r.headers["x-request-id"]


def test_guard_fails_closed_with_503_when_status_is_unreadable():
    def get(tenant):
        raise ServiceUnavailable("db down")

    app = FastAPI()
    app.state._token_verifier = SimpleNamespace(verify=lambda token: SimpleNamespace(tenant_id=T))
    app.state._tenant_status_store = SimpleNamespace(get=get)
    install_tenant_status_guard(app)

    @app.get("/api/x")
    def get_x():
        return {"ok": True}

    assert TestClient(app).get("/api/x", headers={"Authorization": "Bearer good"}).status_code == 503


def test_lifecycle_routes_report_unknown_tenant_with_a_dedicated_code():
    """Operator 靠这个 code 区分“Manager 没有该租户”和“Manager 版本太旧、没有这条路由”（后者是通用 not_found）。"""
    hdr = {"Idempotency-Key": "idem-1"}
    for suffix, body in (("status", {"status": "closed"}), ("purge", {})):
        path = f"/api/manager/tenants/{T}/{suffix}"
        r = _route_client(FakeStore(None), body, path).post(path, json=body, headers=hdr)
        assert r.status_code == 404 and r.json()["code"] == "tenant_not_found"


def test_remove_tenant_files_logs_what_could_not_be_removed(tmp_path, monkeypatch, caplog):
    import logging

    from manager_service import tenant_status

    for namespace in ("knowledge", "avatars"):
        (tmp_path / namespace / T).mkdir(parents=True)
        (tmp_path / namespace / T / "f.bin").write_bytes(b"x")
    real_rmtree = tenant_status.shutil.rmtree

    def rmtree(path, ignore_errors=False):
        if "avatars" in str(path):
            return  # 模拟删除失败（权限 / 占用）
        real_rmtree(path, ignore_errors=ignore_errors)

    monkeypatch.setattr(tenant_status.shutil, "rmtree", rmtree)
    with caplog.at_level(logging.WARNING, logger="manager_service.tenant_status"):
        left = tenant_status._remove_tenant_files(tmp_path, T)
    assert not (tmp_path / "knowledge" / T).exists()
    assert left == [f"avatars/{T}"]
    assert any("could not be removed" in record.getMessage() for record in caplog.records)


def test_login_message_for_a_suspended_tenant_does_not_promise_read_only_access():
    """暂停的企业不能新登录：登录时的提示不能是“仅可查看”（那是已登录会话的提示）。"""
    from manager_service.tenant_status import TenantUnavailable

    in_session = TenantUnavailable("suspended")
    at_login = TenantUnavailable("suspended", at_login=True)
    assert in_session.code == at_login.code == "tenant_suspended"
    assert "仅可查看" in str(in_session.detail)
    assert "仅可查看" not in str(at_login.detail) and "无法登录" in str(at_login.detail)
    assert TenantUnavailable("banned", at_login=True).detail == TenantUnavailable("banned").detail


def test_issuing_a_token_for_a_suspended_tenant_uses_the_login_message(monkeypatch):
    from manager_service import tenant_status
    from manager_service.auth_service import AuthService

    monkeypatch.setattr(tenant_status, "fetch_tenant_status", lambda dsn, tenant_id: "suspended")
    service = AuthService.__new__(AuthService)
    service._admin_dsn = "postgresql://unused"
    with pytest.raises(tenant_status.TenantUnavailable) as raised:
        service._assert_tenant_active(T)
    assert raised.value.code == "tenant_suspended" and "无法登录" in str(raised.value.detail)
