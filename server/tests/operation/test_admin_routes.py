"""运营端 admin 路由测试（S01/S03/S04）。

经 TestClient + dependency_overrides 注入服务；断言鉴权、envelope、
problem+json、企业操作真实改变状态、统计/财务/方案/健康返回非空壳数据。
"""

import pytest
from fastapi.testclient import TestClient

from operation_service.admin_dependencies import get_admin_service
from operation_service.admin_repository import AdminRepository
from operation_service.admin_service import AdminService
from operation_service.catalog_repository import CatalogRepository
from operation_service.repository import InMemoryEnterpriseRepository
from operation_service.rollup_repository import CrossEnterpriseRollupRepository
from run import get_app
from shared.contracts.enums import EnterpriseRole, PlatformRole
from tests.operation.auth_helpers import operation_test_token


@pytest.fixture
def admin_repo():
    return AdminRepository()


@pytest.fixture
def enterprise_repo():
    return InMemoryEnterpriseRepository()


@pytest.fixture
def catalog_repo():
    return CatalogRepository()


@pytest.fixture
def rollup_repo():
    return CrossEnterpriseRollupRepository()


@pytest.fixture
def client(admin_repo, enterprise_repo, catalog_repo, rollup_repo):
    app = get_app("operation")
    service = AdminService(admin_repo, enterprise_repo, catalog_repo, rollup_repo)
    app.dependency_overrides[get_admin_service] = lambda: service
    yield TestClient(app)
    app.dependency_overrides.clear()


def _token(role: str) -> str:
    from operation_service.app import _auth
    return operation_test_token(_auth, user_id="op1", role=role)


def _auth(role: str = PlatformRole.SYSTEM_OPERATOR.value) -> dict:
    return {"Authorization": f"Bearer {_token(role)}"}


# ---- 鉴权 ----

def test_enterprise_list_requires_auth(client):
    r = client.get("/api/operation/admin/enterprises")
    assert r.status_code == 401
    assert r.json()["code"] == "unauthorized"


def test_enterprise_list_forbidden_for_non_platform_role(client):
    r = client.get(
        "/api/operation/admin/enterprises",
        headers=_auth(EnterpriseRole.MEMBER.value),
    )
    assert r.status_code == 403
    assert r.json()["code"] == "forbidden"


# ---- 健康 ----

def test_health_accessible(client):
    r = client.get("/api/operation/admin/health", headers=_auth())
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["status"] in ("healthy", "degraded")
    assert "timestamp" in data
    assert data["services"]["operation"] == "up"


# ---- 统计 ----

def test_stats_returns_envelope(client):
    r = client.get("/api/operation/admin/stats", headers=_auth())
    assert r.status_code == 200
    data = r.json()["data"]
    assert "total_enterprises" in data
    assert "total_recharged" in data


# ---- 方案统计 ----

def test_solution_stats_returns_envelope(client):
    r = client.get("/api/operation/admin/solutions/stats", headers=_auth())
    assert r.status_code == 200
    assert isinstance(r.json()["data"], list)


# ---- 财务 ----

def test_finance_overview_accessible(client):
    r = client.get("/api/operation/admin/finance/overview?period=month", headers=_auth())
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["period"] == "month"
    assert "total_recharged" in data


def test_finance_reports_accessible(client):
    r = client.get("/api/operation/admin/finance/reports", headers=_auth())
    assert r.status_code == 200
    data = r.json()["data"]
    assert "recharge_details" in data
    assert "consumption_details" in data


# ---- 企业列表 ----

def test_enterprise_list_empty_when_no_enterprises(client):
    r = client.get("/api/operation/admin/enterprises", headers=_auth())
    assert r.status_code == 200
    assert r.json()["data"] == []


def test_openapi_exposes_admin_routes(client):
    paths = client.get("/openapi.json").json()["paths"]
    assert "/api/operation/admin/enterprises" in paths
    assert "/api/operation/admin/enterprises/{org_id}" in paths
    assert "/api/operation/admin/enterprises/export/all" in paths
    assert "/api/operation/admin/enterprises/{org_id}/actions" in paths
    assert "/api/operation/admin/enterprises/{org_id}/model-access" in paths
    assert "/api/operation/admin/stats" in paths
    assert "/api/operation/admin/solutions/stats" in paths
    assert "/api/operation/admin/finance/overview" in paths
    assert "/api/operation/admin/finance/reports" in paths
    assert "/api/operation/admin/health" in paths


# ---- R5 删除 / 恢复 / 清理 ----

def _provision_closed(client, enterprise_repo, admin_repo, name="删除测试企业"):
    from operation_service.schemas import ProvisionEnterpriseRequest
    from operation_service.service import ProvisioningService
    from tests.operation.test_admin_service import FakeManagerGateway

    svc = ProvisioningService(enterprise_repo, FakeManagerGateway(), admin_repo=admin_repo)
    eid = svc.provision_enterprise(
        ProvisionEnterpriseRequest(enterprise_name=name, owner_phone="13800000000")
    ).enterprise_id
    r = client.post(
        f"/api/operation/admin/enterprises/{eid}/lifecycle",
        json={"action": "close"}, headers=_auth(PlatformRole.SYSTEM_ADMIN.value),
    )
    assert r.status_code == 200
    return eid


def test_delete_is_system_admin_only_and_requires_matching_name(client, enterprise_repo, admin_repo):
    eid = _provision_closed(client, enterprise_repo, admin_repo)
    url = f"/api/operation/admin/enterprises/{eid}/delete"
    op = _auth(PlatformRole.SYSTEM_OPERATOR.value)
    admin = _auth(PlatformRole.SYSTEM_ADMIN.value)
    assert client.post(url, json={"confirm_name": "删除测试企业"}).status_code == 401
    assert client.post(url, json={"confirm_name": "删除测试企业"}, headers=op).status_code == 403
    assert client.post(url, json={"confirm_name": "错误名称"}, headers=admin).status_code == 422
    ok = client.post(url, json={"confirm_name": "删除测试企业"}, headers=admin)
    assert ok.status_code == 200 and ok.json()["data"]["operation_status"] == "deleted"
    assert admin_repo.get_state(eid).operation_status == "deleted"


def test_delete_requires_closed_enterprise(client, enterprise_repo, admin_repo):
    from operation_service.schemas import ProvisionEnterpriseRequest
    from operation_service.service import ProvisioningService
    from tests.operation.test_admin_service import FakeManagerGateway

    svc = ProvisioningService(enterprise_repo, FakeManagerGateway(), admin_repo=admin_repo)
    eid = svc.provision_enterprise(
        ProvisionEnterpriseRequest(enterprise_name="活跃企业", owner_phone="13800000001")
    ).enterprise_id
    r = client.post(
        f"/api/operation/admin/enterprises/{eid}/delete",
        json={"confirm_name": "活跃企业"}, headers=_auth(PlatformRole.SYSTEM_ADMIN.value),
    )
    assert r.status_code == 409


def test_restore_and_purge_routes_and_lifecycle_lock(client, enterprise_repo, admin_repo):
    eid = _provision_closed(client, enterprise_repo, admin_repo)
    admin = _auth(PlatformRole.SYSTEM_ADMIN.value)
    client.post(f"/api/operation/admin/enterprises/{eid}/delete", json={"confirm_name": "删除测试企业"}, headers=admin)

    # 已删除：生命周期动作一律 409；保留期内恢复为 closed；未满期清理 409
    assert client.post(f"/api/operation/admin/enterprises/{eid}/lifecycle", json={"action": "activate"}, headers=admin).status_code == 409
    assert client.post(f"/api/operation/admin/enterprises/{eid}/purge", headers=admin).status_code == 409
    assert client.post(f"/api/operation/admin/enterprises/{eid}/restore", headers=_auth()).status_code == 403
    restored = client.post(f"/api/operation/admin/enterprises/{eid}/restore", headers=admin)
    assert restored.status_code == 200 and restored.json()["data"]["operation_status"] == "closed"


@pytest.mark.parametrize("state", ["deleting", "deleted"])
def test_legacy_action_endpoint_cannot_pull_an_enterprise_out_of_deletion(client, enterprise_repo, admin_repo, state):
    """旧的企业操作接口（system_operator 可用）不能把删除流程中的企业改回已注销，绕过保留期与 system_admin 限制。"""
    eid = _provision_closed(client, enterprise_repo, admin_repo)
    admin_repo.set_operation_status(eid, "deleting", normalized=True)
    if state == "deleted":
        admin_repo.set_operation_status(eid, "deleted", normalized=True)
    for action in ("close", "reactivate", "unban", "suspend", "ban"):
        r = client.post(
            f"/api/operation/admin/enterprises/{eid}/actions", json={"action": action},
            headers={**_auth(), "Idempotency-Key": f"k-{state}-{action}"},
        )
        assert r.status_code == 409, (action, r.text)
    assert admin_repo.get_state(eid).operation_status == state


def test_deleted_enterprise_hidden_from_default_list(client, enterprise_repo, admin_repo):
    eid = _provision_closed(client, enterprise_repo, admin_repo)
    admin = _auth(PlatformRole.SYSTEM_ADMIN.value)
    client.post(f"/api/operation/admin/enterprises/{eid}/delete", json={"confirm_name": "删除测试企业"}, headers=admin)
    default = client.get("/api/operation/admin/enterprises", headers=admin).json()
    assert eid not in [i["org_id"] for i in default["data"]]
    filtered = client.get("/api/operation/admin/enterprises?status=deleted", headers=admin).json()
    assert [i["org_id"] for i in filtered["data"]] == [eid]
    assert filtered["data"][0]["deleted_at"] is not None
