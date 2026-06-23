"""Operation 目录拉取端点测试（Manager→Operator，05 F06/F07，#176）。

验证服务间调用（X-Service-Token）、Envelope 响应、只读拉取已发布模板、404/401 错误处理。
"""

import os
import pytest
from fastapi.testclient import TestClient

from operation_service.catalog_dependencies import get_catalog_service
from operation_service.catalog_gateway import CatalogManagerGateway
from operation_service.catalog_repository import CatalogRepository
from operation_service.catalog_service import CatalogService
from run import get_app
from shared.contracts.crosstier import CatalogReleaseNotify


# 在模块加载时就设置环境变量
os.environ["SERVICE_TOKEN"] = "test-service-token"


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


def _service_auth() -> dict:
    """服务间调用认证头（X-Service-Token）。"""
    return {"X-Service-Token": "test-service-token"}


def _register_and_publish_expert(client):
    """辅助：注册并发布专家模板。"""
    from shared.contracts.enums import PlatformRole

    def _token(role: str) -> str:
        from operation_service.app import _auth
        from shared.contracts.auth import TokenClaims
        return _auth.signer.sign(TokenClaims(user_id="op1", roles=[role], exp=9999999999))

    def _auth_header(role: str = PlatformRole.SYSTEM_OPERATOR.value) -> dict:
        return {"Authorization": f"Bearer {_token(role)}"}

    # 注册
    client.post(
        "/api/operation/catalog/expert-templates",
        json={"template_id": "tpl-cmo", "display_name": "CMO", "persona": "marketing leader"},
        headers=_auth_header(),
    )
    # 发布
    client.post(
        "/api/operation/catalog/expert_template/tpl-cmo/publish",
        json={},
        headers=_auth_header(),
    )


def _register_and_publish_solution(client):
    """辅助：注册并发布方案模板。"""
    from shared.contracts.enums import PlatformRole

    def _token(role: str) -> str:
        from operation_service.app import _auth
        from shared.contracts.auth import TokenClaims
        return _auth.signer.sign(TokenClaims(user_id="op1", roles=[role], exp=9999999999))

    def _auth_header(role: str = PlatformRole.SYSTEM_OPERATOR.value) -> dict:
        return {"Authorization": f"Bearer {_token(role)}"}

    # 先发布依赖的专家模板
    _register_and_publish_expert(client)

    # 注册方案
    client.post(
        "/api/operation/catalog/solution-templates",
        json={
            "solution_id": "sol-marketing",
            "display_name": "Marketing Solution",
            "expert_template_ids": ["tpl-cmo"],
        },
        headers=_auth_header(),
    )
    # 发布
    client.post(
        "/api/operation/catalog/solution_template/sol-marketing/publish",
        json={},
        headers=_auth_header(),
    )


# ---- 服务间认证 ----

def test_pull_requires_service_token(client):
    """拉取端点需要服务间认证（X-Service-Token）。"""
    r = client.get("/api/operation/catalog/pull/expert-templates/tpl-cmo")
    assert r.status_code == 401
    assert r.json()["code"] == "unauthorized"


# ---- 拉取专家模板详情 ----

def test_pull_expert_template_envelope(client):
    """F06：拉取已发布专家模板详情，返回 Envelope[ExpertTemplateDetail]。"""
    _register_and_publish_expert(client)

    r = client.get(
        "/api/operation/catalog/pull/expert-templates/tpl-cmo",
        headers=_service_auth(),
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["template_id"] == "tpl-cmo"
    assert data["version"] == "1"
    assert data["display_name"] == "CMO"
    assert data["persona"] == "marketing leader"


def test_pull_expert_template_not_found(client):
    """拉取不存在的模板 → 404。"""
    r = client.get(
        "/api/operation/catalog/pull/expert-templates/ghost",
        headers=_service_auth(),
    )
    assert r.status_code == 404
    assert r.json()["code"] == "not_found"


def test_pull_expert_template_not_published(client):
    """拉取未发布的模板 → 404（只能拉 PUBLISHED 状态）。"""
    from shared.contracts.enums import PlatformRole

    def _token(role: str) -> str:
        from operation_service.app import _auth
        from shared.contracts.auth import TokenClaims
        return _auth.signer.sign(TokenClaims(user_id="op1", roles=[role], exp=9999999999))

    def _auth_header(role: str = PlatformRole.SYSTEM_OPERATOR.value) -> dict:
        return {"Authorization": f"Bearer {_token(role)}"}

    # 只注册，不发布
    client.post(
        "/api/operation/catalog/expert-templates",
        json={"template_id": "tpl-draft", "display_name": "Draft"},
        headers=_auth_header(),
    )

    r = client.get(
        "/api/operation/catalog/pull/expert-templates/tpl-draft",
        headers=_service_auth(),
    )
    assert r.status_code == 404


# ---- 拉取方案包 ----

def test_pull_solution_package_envelope(client):
    """F07：拉取已发布方案包，返回 Envelope[SolutionPackage] 含展开的专家。"""
    _register_and_publish_solution(client)

    r = client.get(
        "/api/operation/catalog/pull/solution-templates/sol-marketing",
        headers=_service_auth(),
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["solution_id"] == "sol-marketing"
    assert data["version"] == "1"
    assert data["display_name"] == "Marketing Solution"
    assert len(data["experts"]) == 1
    assert data["experts"][0]["template_id"] == "tpl-cmo"


def test_pull_solution_package_not_found(client):
    """拉取不存在的方案包 → 404。"""
    r = client.get(
        "/api/operation/catalog/pull/solution-templates/ghost",
        headers=_service_auth(),
    )
    assert r.status_code == 404


# ---- 列举模板 ----

def test_list_expert_templates_envelope(client):
    """F06：列举可招募专家模板，只返回 PUBLISHED 状态。"""
    _register_and_publish_expert(client)

    r = client.get(
        "/api/operation/catalog/pull/expert-templates",
        headers=_service_auth(),
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data) >= 1
    assert any(item["template_id"] == "tpl-cmo" for item in data)


def test_list_solution_packages_envelope(client):
    """F07：列举可应用方案包，只返回 PUBLISHED 状态。"""
    _register_and_publish_solution(client)

    r = client.get(
        "/api/operation/catalog/pull/solution-templates",
        headers=_service_auth(),
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data) >= 1
    assert any(item["solution_id"] == "sol-marketing" for item in data)


def test_openapi_exposes_pull_routes(client):
    """验证 OpenAPI 文档暴露拉取端点。"""
    paths = client.get("/openapi.json").json()["paths"]
    assert "/api/operation/catalog/pull/expert-templates/{template_id}" in paths
    assert "/api/operation/catalog/pull/solution-templates/{solution_id}" in paths
    assert "/api/operation/catalog/pull/expert-templates" in paths
    assert "/api/operation/catalog/pull/solution-templates" in paths
