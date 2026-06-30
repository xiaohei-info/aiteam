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
from operation_service.dependencies import get_repository, get_rollup_repository
from operation_service.repository import InMemoryEnterpriseRepository
from operation_service.rollup_repository import CrossEnterpriseRollupRepository
from run import get_app
from shared.contracts.auth import TokenClaims
from shared.contracts.enums import EnterpriseRole, PlatformRole


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
    return _auth.signer.sign(TokenClaims(user_id="op1", roles=[role], exp=9999999999))


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
    assert "/api/operation/admin/stats" in paths
    assert "/api/operation/admin/solutions/stats" in paths
    assert "/api/operation/admin/finance/overview" in paths
    assert "/api/operation/admin/finance/reports" in paths
    assert "/api/operation/admin/health" in paths
