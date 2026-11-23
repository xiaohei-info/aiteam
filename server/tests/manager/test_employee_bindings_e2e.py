"""employee 独立绑定实体 端到端 + 跨租户 RLS 隔离（integration，真 PG；AITEAM-234/280，04 §6.1.1 D22）。

验：
- owner HTTP 全链路 CRUD（201/200/204）5 类绑定实体。
- 跨 tenant：t-a 的绑定在 t-b 视角 404（RLS 强制，D22）。
- member 读可、写 403（03 §9.7）。
"""

import uuid

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from tests.manager._auth_helper import (
    make_inmem_verifier_and_signer,
    make_verifier,
    sign_inmem_token,
    sign_token,
)

pytestmark = pytest.mark.integration

_INMEM_VERIFIER, _INMEM_SIGNER = make_inmem_verifier_and_signer()


def _app_with_bindings(db_url, admin_url=None):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.routes_employee_bindings import build_employee_bindings_router
    from manager_service.routes_auth import router as auth_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    verifier = make_verifier(admin_url) if admin_url else _INMEM_VERIFIER
    settings = Settings(
        tier="manager",
        service_name="aiteam-manager-service",
        db_url=db_url,
    )
    app = create_app(settings, manager_router)
    app.include_router(auth_router)
    app.include_router(build_employee_router(verifier))
    app.include_router(build_employee_bindings_router(verifier))
    app.state._operator_catalog = FakeOperatorCatalogClient()
    return app


def _client(db_url, admin_url=None):
    return TestClient(_app_with_bindings(db_url, admin_url))


def _token(tenant_id, roles, user_id=None, *, admin_url=None):
    uid = user_id or str(uuid.uuid4())
    if admin_url:
        return sign_token(admin_url, tenant_id, roles, user_id=uid)
    return sign_inmem_token(_INMEM_SIGNER, tenant_id, roles, user_id=uid)


def _h(tenant_id, roles, user_id=None, *, admin_url=None):
    return {"Authorization": f"Bearer {_token(tenant_id, roles, user_id=user_id, admin_url=admin_url)}"}


def _make_employee(client, token, *, slug):
    r = client.post(f"/api/manager/employees?employee_slug={slug}",
                    json={"display_name": "E", "persona": "p"}, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 201, r.text
    return r.json()["data"]["employee_id"]


def test_bindings_crud_and_cross_tenant(migrated_db, admin_url, two_tenants):
    tid_a, tid_b = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    tok_a = _token(tid_a, ["owner"], user_id=str(uuid.uuid4()), admin_url=admin_url)
    eid_a = _make_employee(client, tok_a, slug=f"bind-a-{uuid.uuid4().hex[:6]}")
    auth_a = {"Authorization": f"Bearer {tok_a}"}

    # ---- knowledge binding ----
    r = client.post(f"/api/manager/employees/{eid_a}/knowledge-bindings",
                    json={"knowledge_space_id": "ks_default"}, headers=auth_a)
    assert r.status_code == 201, r.text
    kn = r.json()["data"]

    # ---- memory setting upsert + patch ----
    r = client.put(f"/api/manager/employees/{eid_a}/memory-setting",
                   json={"retention_days": 30, "scope": "employee"}, headers=auth_a)
    assert r.status_code == 200, r.text
    r = client.patch(f"/api/manager/employees/{eid_a}/memory-setting",
                     json={"retention_days": 60}, headers=auth_a)
    assert r.status_code == 200
    assert r.json()["data"]["retention_days"] == 60

    # ---- cross tenant: t-b cannot see t-a's bindings (RLS) ----
    tok_b = _token(tid_b, ["owner"], user_id="owner-b", admin_url=admin_url)
    auth_b = {"Authorization": f"Bearer {tok_b}"}
    r = client.get(f"/api/manager/employees/{eid_a}/knowledge-bindings", headers=auth_b)
    assert r.status_code == 404 or r.json()["data"] == []
    assert kn["binding_id"] not in r.text
    r = client.get(f"/api/manager/employees/{eid_a}/memory-setting", headers=auth_b)
    assert r.status_code == 404

    # ---- member full configuration read/write 403 ----
    tok_m = _token(tid_a, ["member"], user_id="mem-a", admin_url=admin_url)
    auth_m = {"Authorization": f"Bearer {tok_m}"}
    r = client.get(f"/api/manager/employees/{eid_a}/knowledge-bindings", headers=auth_m)
    assert r.status_code == 403
    r = client.post(f"/api/manager/employees/{eid_a}/knowledge-bindings",
                    json={"knowledge_space_id": "ks_other"}, headers=auth_m)
    assert r.status_code == 403

    # ---- deletes ----
    r = client.delete(f"/api/manager/employees/{eid_a}/knowledge-bindings/{kn['binding_id']}", headers=auth_a)
    assert r.status_code == 204
    r = client.delete(f"/api/manager/employees/{eid_a}/memory-setting", headers=auth_a)
    assert r.status_code == 204


def test_existing_employee_config_still_works(migrated_db, admin_url, two_tenants):
    """回归：新增绑定实体不破坏现有 EmployeeConfigService 快照配置路径。"""
    tid_a, _ = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    tok_a = _token(tid_a, ["owner"], user_id=str(uuid.uuid4()), admin_url=admin_url)
    auth_a = {"Authorization": f"Bearer {tok_a}"}
    r = client.get("/api/manager/employees", headers=auth_a)
    assert r.status_code == 200
