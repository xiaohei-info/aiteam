"""企业开通北向路由测试（/api/operation，05 F01/F02）。

经 TestClient + dependency_overrides 注入 fake 网关与全新仓储；断言鉴权、envelope、
problem+json、一次性明文不落库、OpenAPI 暴露。
"""

import pytest
from fastapi.testclient import TestClient

from operation_service.dependencies import get_provisioning_service
from operation_service.manager_gateway import ManagerGateway
from operation_service.repository import InMemoryEnterpriseRepository
from operation_service.service import ProvisioningService
from run import get_app
from shared.contracts.crosstier import EnterpriseNotifyRequest, OwnerBootstrapSync, TenantProvisionRequest
from shared.contracts.enums import EnterpriseRole, PlatformRole
from shared.config import Settings
from tests.operation.auth_helpers import operation_test_token


def test_operation_production_startup_guards(monkeypatch):
    import operation_service.app as operation_app

    production = Settings(
        tier="operation", service_name="operation", aiteam_env="production",
        db_url="postgresql://app_rw@localhost/operation",
        admin_db_url="postgresql://admin@localhost/operation",
    )
    monkeypatch.setenv("AITEAM_COMPOSE_MODE", "1")
    with pytest.raises(RuntimeError, match="Docker Compose is unsupported"):
        operation_app._validate_production_startup(production)
    monkeypatch.delenv("AITEAM_COMPOSE_MODE")
    monkeypatch.setattr(operation_app, "newapi_urls", lambda **_: ("http://newapi", None))
    with pytest.raises(ValueError, match="NEWAPI_PUBLIC_BASE_URL"):
        operation_app._validate_production_startup(production)
    monkeypatch.setattr(operation_app, "newapi_urls", lambda **_: ("http://newapi", "https://relay.example/v1"))
    operation_app._validate_production_startup(production)


class FakeManagerGateway(ManagerGateway):
    def set_tenant_status(self, tenant_id, status, *, reason=None, idempotency_key): pass
    def purge_tenant(self, tenant_id, *, idempotency_key): pass
    def __init__(self) -> None:
        self.provisioned: list[TenantProvisionRequest] = []
        self.bootstraps: list[OwnerBootstrapSync] = []
        self.notifications: list[EnterpriseNotifyRequest] = []

    def provision_tenant(self, req, *, idempotency_key):
        self.provisioned.append(req)

    def sync_owner_bootstrap(self, req, *, idempotency_key):
        self.bootstraps.append(req)

    def notify_enterprise(self, req, *, idempotency_key):
        self.notifications.append(req)


@pytest.fixture
def manager():
    return FakeManagerGateway()


@pytest.fixture
def repo():
    return InMemoryEnterpriseRepository()


@pytest.fixture
def client(manager, repo):
    app = get_app("operation")
    app.dependency_overrides[get_provisioning_service] = lambda: ProvisioningService(repo, manager)
    yield TestClient(app)
    app.dependency_overrides.clear()


def _token(role: str) -> str:
    # 用 Operation app 的真实系统 RS256 key 签发（与 app._verifier 闭环，D23）。
    from operation_service.app import _auth

    return operation_test_token(_auth, user_id="op1", role=role)


def _auth(role: str) -> dict:
    return {"Authorization": f"Bearer {_token(role)}"}


def _headers(role: str, key: str) -> dict:
    return {**_auth(role), "Idempotency-Key": key}


_BODY = {"enterprise_name": "Acme", "owner_phone": "13800000000"}


def test_provision_requires_auth(client):
    r = client.post("/api/operation/enterprises", json=_BODY)
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "unauthorized"


def test_provision_forbidden_for_non_platform_role(client):
    r = client.post(
        "/api/operation/enterprises", json=_BODY, headers=_headers(EnterpriseRole.MEMBER.value, "forbidden-provision")
    )
    assert r.status_code == 403
    assert r.json()["code"] == "forbidden"


@pytest.mark.parametrize(
    "role", [PlatformRole.SYSTEM_ADMIN.value, PlatformRole.SYSTEM_OPERATOR.value]
)
def test_provision_success_envelope(client, manager, role):
    r = client.post("/api/operation/enterprises", json=_BODY, headers=_headers(role, f"provision-{role}"))
    assert r.status_code == 201
    data = r.json()["data"]
    assert data["enterprise_name"] == "Acme"
    assert data["owner_phone"] == "13800000000"
    assert data["must_reset"] is True
    assert data["enterprise_id"] and data["tenant_id"]
    assert data["owner_bootstrap_secret"]
    # 跨端传明文 bootstrap（Manager 单一 hash 真相源）；与 Operator 返回的一致。
    assert manager.bootstraps[0].bootstrap_secret == data["owner_bootstrap_secret"]


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
        "/api/operation/enterprises", json=_BODY, headers=_headers(PlatformRole.SYSTEM_ADMIN.value, "reset-provision")
    ).json()["data"]
    eid = created["enterprise_id"]

    r = client.post(
        f"/api/operation/enterprises/{eid}/owner-bootstrap/reset",
        headers=_headers(PlatformRole.SYSTEM_ADMIN.value, "reset-key"),
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["enterprise_id"] == eid
    assert data["tenant_id"] == created["tenant_id"]
    assert data["owner_bootstrap_secret"] != created["owner_bootstrap_secret"]


def test_reset_unknown_enterprise_404(client):
    r = client.post(
        "/api/operation/enterprises/nope/owner-bootstrap/reset",
        headers=_headers(PlatformRole.SYSTEM_OPERATOR.value, "reset-unknown"),
    )
    assert r.status_code == 404
    assert r.json()["code"] == "not_found"


def test_enterprise_profile_roundtrip(client):
    """R3：企业行业 / 标签的读取与保存（发布范围匹配用）。"""
    admin = PlatformRole.SYSTEM_ADMIN.value
    created = client.post(
        "/api/operation/enterprises",
        json={**_BODY, "industry": "制造业", "tags": ["KA"]},
        headers=_headers(admin, "profile-provision"),
    ).json()["data"]
    eid = created["enterprise_id"]

    got = client.get(f"/api/operation/enterprises/{eid}/profile", headers=_auth(admin))
    assert got.status_code == 200
    assert got.json()["data"] == {"enterprise_id": eid, "industry": "制造业", "tags": ["KA"]}

    put = client.put(
        f"/api/operation/enterprises/{eid}/profile",
        json={"industry": " 金融 ", "tags": ["A", "B", "A"]},
        headers=_auth(PlatformRole.SYSTEM_OPERATOR.value),
    )
    assert put.status_code == 200
    assert put.json()["data"] == {"enterprise_id": eid, "industry": "金融", "tags": ["A", "B"]}
    assert client.get(f"/api/operation/enterprises/{eid}/profile", headers=_auth(admin)).json()["data"]["industry"] == "金融"

    # 没传的字段保持原值：前端读取失败后误发的空请求不会把已有资料覆盖成空（#204 评论）。
    kept = client.put(f"/api/operation/enterprises/{eid}/profile", json={}, headers=_auth(admin))
    assert kept.json()["data"] == {"enterprise_id": eid, "industry": "金融", "tags": ["A", "B"]}
    only_tags = client.put(f"/api/operation/enterprises/{eid}/profile", json={"tags": ["KA"]}, headers=_auth(admin))
    assert only_tags.json()["data"] == {"enterprise_id": eid, "industry": "金融", "tags": ["KA"]}

    cleared = client.put(
        f"/api/operation/enterprises/{eid}/profile", json={"industry": None, "tags": []}, headers=_auth(admin),
    )
    assert cleared.json()["data"] == {"enterprise_id": eid, "industry": None, "tags": []}


def test_enterprise_profile_auth_and_errors(client):
    admin = PlatformRole.SYSTEM_ADMIN.value
    assert client.get("/api/operation/enterprises/nope/profile").status_code == 401
    assert client.get(
        "/api/operation/enterprises/nope/profile", headers=_auth(EnterpriseRole.MEMBER.value)
    ).status_code == 403
    missing = client.get("/api/operation/enterprises/nope/profile", headers=_auth(admin))
    assert missing.status_code == 404 and missing.json()["code"] == "not_found"
    assert client.put("/api/operation/enterprises/nope/profile", json={}, headers=_auth(admin)).status_code == 404
    too_long = client.put(
        "/api/operation/enterprises/nope/profile", json={"industry": "x" * 21}, headers=_auth(admin)
    )
    assert too_long.status_code == 422


def test_openapi_exposes_enterprise_routes(client):
    paths = client.get("/openapi.json").json()["paths"]
    assert "/api/operation/enterprises" in paths
    assert "/api/operation/enterprises/{enterprise_id}/owner-bootstrap/reset" in paths
