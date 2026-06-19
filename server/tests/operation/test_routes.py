"""企业开通北向路由测试（/api/operation，05 F01/F02）。

经 TestClient + dependency_overrides 注入 fake 网关与全新仓储；断言鉴权、envelope、
problem+json、一次性明文不落库、OpenAPI 暴露。
"""

import pytest
from fastapi.testclient import TestClient

from operation_service.dependencies import get_provisioning_service
from operation_service.manager_gateway import ManagerGateway
from operation_service.repository import EnterpriseRepository
from operation_service.service import ProvisioningService
from run import get_app
from shared.auth import DevTokenService
from shared.contracts.auth import TokenClaims
from shared.contracts.crosstier import OwnerBootstrapSync, TenantProvisionRequest
from shared.contracts.enums import EnterpriseRole, PlatformRole


class FakeManagerGateway(ManagerGateway):
    def __init__(self) -> None:
        self.provisioned: list[TenantProvisionRequest] = []
        self.bootstraps: list[OwnerBootstrapSync] = []

    def provision_tenant(self, req, *, idempotency_key):
        self.provisioned.append(req)

    def sync_owner_bootstrap(self, req, *, idempotency_key):
        self.bootstraps.append(req)


@pytest.fixture
def manager():
    return FakeManagerGateway()


@pytest.fixture
def repo():
    return EnterpriseRepository()


@pytest.fixture
def client(manager, repo):
    app = get_app("operation")
    app.dependency_overrides[get_provisioning_service] = lambda: ProvisioningService(repo, manager)
    yield TestClient(app)
    app.dependency_overrides.clear()


def _token(role: str) -> str:
    return DevTokenService().sign(
        TokenClaims(user_id="op1", roles=[role], exp=9999999999)
    )


def _auth(role: str) -> dict:
    return {"Authorization": f"Bearer {_token(role)}"}


_BODY = {"enterprise_name": "Acme", "owner_phone": "13800000000"}


def test_provision_requires_auth(client):
    r = client.post("/api/operation/enterprises", json=_BODY)
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "unauthorized"


def test_provision_forbidden_for_non_platform_role(client):
    r = client.post(
        "/api/operation/enterprises", json=_BODY, headers=_auth(EnterpriseRole.MEMBER.value)
    )
    assert r.status_code == 403
    assert r.json()["code"] == "forbidden"


@pytest.mark.parametrize(
    "role", [PlatformRole.SYSTEM_ADMIN.value, PlatformRole.SYSTEM_OPERATOR.value]
)
def test_provision_success_envelope(client, manager, role):
    r = client.post("/api/operation/enterprises", json=_BODY, headers=_auth(role))
    assert r.status_code == 201
    data = r.json()["data"]
    assert data["enterprise_name"] == "Acme"
    assert data["owner_phone"] == "13800000000"
    assert data["must_reset"] is True
    assert data["enterprise_id"] and data["tenant_id"]
    assert data["owner_bootstrap_secret"]
    # 跨端只收到了 hash，没有明文外泄到 Manager 调用。
    assert manager.bootstraps[0].bootstrap_secret_hash != data["owner_bootstrap_secret"]


def test_provision_validation_error_422(client):
    r = client.post(
        "/api/operation/enterprises",
        json={"enterprise_name": ""},  # 缺 owner_phone 且 name 空
        headers=_auth(PlatformRole.SYSTEM_OPERATOR.value),
    )
    assert r.status_code == 422
    assert r.json()["code"] == "validation_error"


def test_reset_flow(client):
    created = client.post(
        "/api/operation/enterprises", json=_BODY, headers=_auth(PlatformRole.SYSTEM_ADMIN.value)
    ).json()["data"]
    eid = created["enterprise_id"]

    r = client.post(
        f"/api/operation/enterprises/{eid}/owner-bootstrap/reset",
        headers=_auth(PlatformRole.SYSTEM_ADMIN.value),
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["enterprise_id"] == eid
    assert data["tenant_id"] == created["tenant_id"]
    assert data["owner_bootstrap_secret"] != created["owner_bootstrap_secret"]


def test_reset_unknown_enterprise_404(client):
    r = client.post(
        "/api/operation/enterprises/nope/owner-bootstrap/reset",
        headers=_auth(PlatformRole.SYSTEM_OPERATOR.value),
    )
    assert r.status_code == 404
    assert r.json()["code"] == "not_found"


def test_openapi_exposes_enterprise_routes(client):
    paths = client.get("/openapi.json").json()["paths"]
    assert "/api/operation/enterprises" in paths
    assert "/api/operation/enterprises/{enterprise_id}/owner-bootstrap/reset" in paths
