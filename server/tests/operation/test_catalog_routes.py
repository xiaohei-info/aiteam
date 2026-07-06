"""目录北向路由测试（/api/operation/catalog，05 F03）。

经 TestClient + dependency_overrides 注入 fake 网关与全新仓储；断言鉴权、envelope、
problem+json、生命周期流转、Manager 通知、OpenAPI 暴露。
"""

import pytest
from fastapi.testclient import TestClient

from operation_service.catalog_dependencies import get_catalog_service
from operation_service.catalog_gateway import CatalogManagerGateway
from operation_service.catalog_repository import CatalogRepository
from operation_service.catalog_service import CatalogService
from run import get_app
from shared.auth import DevTokenService
from shared.contracts.auth import TokenClaims
from shared.contracts.crosstier import CatalogReleaseNotify
from shared.contracts.enums import EnterpriseRole, PlatformRole


class FakeCatalogGateway(CatalogManagerGateway):
    def __init__(self) -> None:
        self.notifications: list[CatalogReleaseNotify] = []

    def notify_catalog_release(self, notify, *, idempotency_key):
        self.notifications.append(notify)


@pytest.fixture
def manager():
    return FakeCatalogGateway()


@pytest.fixture
def client(manager):
    app = get_app("operation")
    service = CatalogService(CatalogRepository(), manager)
    app.dependency_overrides[get_catalog_service] = lambda: service
    yield TestClient(app)
    app.dependency_overrides.clear()


def _token(role: str) -> str:
    # 用 Operation app 的真实系统 RS256 key 签发（与 app._verifier 闭环，D23）。
    from operation_service.app import _auth

    return _auth.signer.sign(TokenClaims(user_id="op1", roles=[role], exp=9999999999))


def _auth(role: str = PlatformRole.SYSTEM_OPERATOR.value) -> dict:
    return {"Authorization": f"Bearer {_token(role)}"}


_EXPERT = {"template_id": "tpl-cmo", "display_name": "CMO", "category": "marketing", "avatar_url": "https://example.com/cmo.png", "system_prompt": "lead", "default_model": "gpt-5", "skill_ids": ["seo"], "description": "CMO"}


def _register_expert(client, body=None):
    return client.post("/api/operation/catalog/expert-templates", json=body or _EXPERT, headers=_auth())


# ---- 鉴权 ----

def test_register_requires_auth(client):
    r = client.post("/api/operation/catalog/expert-templates", json=_EXPERT)
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "unauthorized"


def test_register_forbidden_for_non_platform_role(client):
    r = client.post(
        "/api/operation/catalog/expert-templates", json=_EXPERT,
        headers=_auth(EnterpriseRole.MEMBER.value),
    )
    assert r.status_code == 403
    assert r.json()["code"] == "forbidden"


# ---- 注册 ----

def test_register_expert_envelope(client, manager):
    r = _register_expert(client)
    assert r.status_code == 201
    data = r.json()["data"]
    assert data["template_id"] == "tpl-cmo"
    assert data["catalog_type"] == "expert_template"
    assert data["status"] == "draft"
    assert manager.notifications == []  # 草稿不通知


def test_register_solution_envelope(client):
    body = {"solution_id": "sol-x", "display_name": "X", "description": "d", "expert_template_ids": ["tpl-cmo"], "planner_template_id": "tpl-cmo", "planner_prompt": "Plan the work"}
    r = client.post("/api/operation/catalog/solution-templates", json=body, headers=_auth())
    assert r.status_code == 201
    assert r.json()["data"]["catalog_type"] == "solution_template"


def test_register_validation_error_422(client):
    r = client.post(
        "/api/operation/catalog/expert-templates", json={"display_name": ""}, headers=_auth()
    )
    assert r.status_code == 422
    assert r.json()["code"] == "validation_error"


# ---- 发布/下架/可见范围 ----

def test_publish_notifies_manager(client, manager):
    _register_expert(client)
    r = client.post(
        "/api/operation/catalog/expert_template/tpl-cmo/publish", json={}, headers=_auth()
    )
    assert r.status_code == 200
    assert r.json()["data"]["status"] == "published"
    assert len(manager.notifications) == 1
    assert manager.notifications[0].action == "published"


def test_unpublish_flow(client, manager):
    _register_expert(client)
    client.post("/api/operation/catalog/expert_template/tpl-cmo/publish", json={}, headers=_auth())
    r = client.post("/api/operation/catalog/expert_template/tpl-cmo/unpublish", headers=_auth())
    assert r.status_code == 200
    assert r.json()["data"]["status"] == "unpublished"
    assert manager.notifications[-1].action == "unpublished"


def test_set_visibility_flow(client, manager):
    _register_expert(client)
    client.post("/api/operation/catalog/expert_template/tpl-cmo/publish", json={}, headers=_auth())
    scope = {"tenant_ids": ["t1"]}
    r = client.put(
        "/api/operation/catalog/expert_template/tpl-cmo/visibility",
        json={"visible_scope": scope}, headers=_auth(),
    )
    assert r.status_code == 200
    assert r.json()["data"]["visible_scope"] == scope
    assert manager.notifications[-1].action == "visibility_changed"


def test_publish_unknown_404(client):
    r = client.post(
        "/api/operation/catalog/expert_template/ghost/publish", json={}, headers=_auth()
    )
    assert r.status_code == 404
    assert r.json()["code"] == "not_found"


def test_invalid_catalog_type_422(client):
    r = client.post(
        "/api/operation/catalog/bogus_type/tpl-cmo/publish", json={}, headers=_auth()
    )
    assert r.status_code == 422


# ---- 列举/获取 ----

def test_list_and_get(client):
    _register_expert(client)
    client.post("/api/operation/catalog/expert_template/tpl-cmo/publish", json={}, headers=_auth())

    listed = client.get(
        "/api/operation/catalog?status=published", headers=_auth()
    ).json()["data"]
    assert len(listed) == 1
    assert listed[0]["template_id"] == "tpl-cmo"

    got = client.get(
        "/api/operation/catalog/expert_template/tpl-cmo", headers=_auth()
    )
    assert got.status_code == 200
    assert got.json()["data"]["template_id"] == "tpl-cmo"


def test_openapi_exposes_catalog_routes(client):
    paths = client.get("/openapi.json").json()["paths"]
    assert "/api/operation/catalog/expert-templates" in paths
    assert "/api/operation/catalog/solution-templates" in paths
    assert "/api/operation/catalog/{catalog_type}/{template_id}/publish" in paths



# ---- AITEAM-355 问题二：北向 HTTP 注册路径服务端自动生成 ID ----

def _assert_url_safe(template_id: str) -> None:
    import re
    assert re.fullmatch(r"[a-z0-9-]+", template_id), template_id


def test_route_register_expert_without_id_returns_201_with_generated_id(client, manager):
    """POST /expert-templates 不传 template_id：201 + 响应含自动生成的 ID + 草稿不通知 Manager。"""
    body = {"display_name": "路由注册-无ID专家", "category": "m", "avatar_url": "h", "system_prompt": "s", "default_model": "g", "skill_ids": ["sk"], "description": "d"}
    r = client.post("/api/operation/catalog/expert-templates", json=body, headers=_auth())
    assert r.status_code == 201, r.text
    data = r.json()["data"]
    assert data["catalog_type"] == "expert_template"
    assert data["status"] == "draft"
    assert data["template_id"]
    _assert_url_safe(data["template_id"])
    assert manager.notifications == []


def test_route_register_solution_without_id_returns_201_with_generated_id(client):
    body = {"display_name": "路由注册-无ID方案", "description": "d", "expert_template_ids": ["tpl-cmo"], "planner_template_id": "tpl-cmo", "planner_prompt": "Plan the work"}
    r = client.post("/api/operation/catalog/solution-templates", json=body, headers=_auth())
    assert r.status_code == 201, r.text
    data = r.json()["data"]
    assert data["catalog_type"] == "solution_template"
    assert data["template_id"]
    _assert_url_safe(data["template_id"])


def test_route_register_omitting_name_still_422(client):
    """display_name 空仍应 422（AITEAM-355 不放松这一契约）。"""
    r = client.post("/api/operation/catalog/expert-templates", json={"display_name": ""}, headers=_auth())
    assert r.status_code == 422


def test_route_register_empty_string_id_rejected_with_422(client, manager):
    """template_id 为空字符串 → schema min_length=1 拒绝（422），不入库空串 ID。"""
    body = {"display_name": "EmptyIdExpert", "template_id": "", "category": "m", "avatar_url": "h", "system_prompt": "s", "default_model": "g", "skill_ids": ["sk"], "description": "d"}
    r = client.post("/api/operation/catalog/expert-templates", json=body, headers=_auth())
    assert r.status_code == 422, r.text
