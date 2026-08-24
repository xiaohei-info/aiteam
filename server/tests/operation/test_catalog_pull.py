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
    class PlatformSkillStore:
        def get_package(self, *, skill_id, version, published_only=False):
            return {"content_hash": "abc123"}
    service = CatalogService(CatalogRepository(), manager, platform_skills=PlatformSkillStore())
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
        json={"template_id": "tpl-cmo", "display_name": "CMO", "category": "marketing", "avatar_url": "https://example.com/cmo.png", "system_prompt": "marketing leader", "default_model": "gpt-5", "skill_ids": ["seo"], "description": "CMO expert"},
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
            "description": "marketing",
            "expert_template_ids": ["tpl-cmo"],
            "planner_template_id": "tpl-cmo",
            "planner_prompt": "Plan marketing campaign",
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
        json={"template_id": "tpl-draft", "display_name": "Draft", "category": "x", "avatar_url": "h", "system_prompt": "s", "default_model": "g", "skill_ids": ["sk"], "description": "d"},
        headers=_auth_header(),
    )

    r = client.get(
        "/api/operation/catalog/pull/expert-templates/tpl-draft",
        headers=_service_auth(),
    )
    assert r.status_code == 404




def _register_solution_with_bindings(client):
    """注册并发布带显式专家绑定（排序号/启用开关）的方案模板。"""
    from shared.contracts.enums import PlatformRole

    def _token(role: str) -> str:
        from operation_service.app import _auth
        from shared.contracts.auth import TokenClaims
        return _auth.signer.sign(TokenClaims(user_id="op1", roles=[role], exp=9999999999))

    def _auth_header(role: str = PlatformRole.SYSTEM_OPERATOR.value) -> dict:
        return {"Authorization": f"Bearer {_token(role)}"}

    for tpl_id, name in [("tpl-cmo", "CMO"), ("tpl-ceo", "CEO")]:
        client.post(
            "/api/operation/catalog/expert-templates",
            json={"template_id": tpl_id, "display_name": name, "category": "x", "avatar_url": "h", "system_prompt": f"{name} system", "default_model": "g", "skill_ids": ["sk"], "description": "d"},
            headers=_auth_header(),
        )
        client.post(
            f"/api/operation/catalog/expert_template/{tpl_id}/publish",
            json={},
            headers=_auth_header(),
        )

    client.post(
        "/api/operation/catalog/solution-templates",
        json={
            "solution_id": "sol-bound",
            "display_name": "Bound Solution",
            "description": "bound sol",
            "planner_template_id": "tpl-ceo",
            "planner_prompt": "Plan bound campaign",
            "expert_bindings": [
                {"template_id": "tpl-cmo", "sequence_no": 2, "enabled": False},
                {"template_id": "tpl-ceo", "sequence_no": 1, "enabled": True},
            ],
        },
        headers=_auth_header(),
    )
    client.post(
        "/api/operation/catalog/solution_template/sol-bound/publish",
        json={},
        headers=_auth_header(),
    )


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


# ---- Issue #278：方案包拉取透传编排规则/蓝图字段 ----

def _register_solution_with_orchestration(client):
    """辅助：注册并发布带编排字段的方案模板。"""
    from shared.contracts.enums import PlatformRole

    def _token(role: str) -> str:
        from operation_service.app import _auth
        from shared.contracts.auth import TokenClaims
        return _auth.signer.sign(TokenClaims(user_id="op1", roles=[role], exp=9999999999))

    def _auth_header(role: str = PlatformRole.SYSTEM_OPERATOR.value) -> dict:
        return {"Authorization": f"Bearer {_token(role)}"}

    # First publish an expert that the orchestration solution references.
    client.post(
        "/api/operation/catalog/expert-templates",
        json={"template_id": "tpl-cmo", "display_name": "CMO", "category": "marketing",
              "avatar_url": "https://example.com/cmo.png", "system_prompt": "marketing leader",
              "default_model": "gpt-5", "skill_ids": ["seo"], "description": "CMO expert"},
        headers=_auth_header(),
    )
    client.post(
        "/api/operation/catalog/expert_template/tpl-cmo/publish",
        json={},
        headers=_auth_header(),
    )
    client.post(
        "/api/operation/catalog/solution-templates",
        json={
            "solution_id": "sol-orch",
            "display_name": "Orchestration Solution",
            "description": "编排方案",
            "expert_template_ids": ["tpl-cmo"],
            "planner_template_id": "tpl-cmo",
            "icon": "icon-orch",
            "planner_prompt": "Plan multi-agent flow",
            "subtask_prompt": "Decompose into subtasks",
            "aggregate_prompt": "Merge expert outputs",
            "tags": ["ai", "agent"],
        },
        headers=_auth_header(),
    )
    client.post(
        "/api/operation/catalog/solution_template/sol-orch/publish",
        json={},
        headers=_auth_header(),
    )


def test_pull_solution_package_includes_orchestration_fields(client):
    """F07：拉取方案包时编排规则/蓝图字段应透传（issue #278 修复验证）。"""
    _register_solution_with_orchestration(client)

    r = client.get(
        "/api/operation/catalog/pull/solution-templates/sol-orch",
        headers=_service_auth(),
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["planner_prompt"] == "Plan multi-agent flow"
    assert data["subtask_prompt"] == "Decompose into subtasks"
    assert data["aggregate_prompt"] == "Merge expert outputs"
    assert data["description"] == "编排方案"
    assert data["icon"] == "icon-orch"
    assert data["tags"] == ["ai", "agent"]


# ---- Issue #279：专家模板模型/绑定/提示词包/分类/角色字段透传 ----

def _register_expert_with_full_config(client):
    """辅助：注册并发布带完整模型/绑定/提示词包/分类/角色字段的专家模板。"""
    from shared.contracts.enums import PlatformRole

    def _token(role: str) -> str:
        from operation_service.app import _auth
        from shared.contracts.auth import TokenClaims
        return _auth.signer.sign(TokenClaims(user_id="op1", roles=[role], exp=9999999999))

    def _auth_header(role: str = PlatformRole.SYSTEM_OPERATOR.value) -> dict:
        return {"Authorization": f"Bearer {_token(role)}"}

    client.post(
        "/api/operation/catalog/expert-templates",
        json={
            "template_id": "tpl-full",
            "display_name": "Full Config Expert",
            "category": "marketing",
            "avatar_url": "https://example.com/a.png",
            "system_prompt": "You are CMO",
            "default_model": "gpt-5",
            "platform_skill_refs": [{
                "skill_id": "00000000-0000-0000-0000-000000000101",
                "version": "1.0.0",
                "content_hash": "abc123",
            }],
            "description": "营销高管",
        },
        headers=_auth_header(),
    )
    client.post(
        "/api/operation/catalog/expert_template/tpl-full/publish",
        json={},
        headers=_auth_header(),
    )


def test_pull_expert_template_includes_flat_config(client):
    """F06：拉取已发布专家模板详情时透传 PRD-v2 扁平字段并回填 persona/recommended_config。"""
    _register_expert_with_full_config(client)

    r = client.get(
        "/api/operation/catalog/pull/expert-templates/tpl-full",
        headers=_service_auth(),
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["template_id"] == "tpl-full"
    assert data["display_name"] == "Full Config Expert"
    assert data["system_prompt"] == "You are CMO"
    assert data["default_model"] == "gpt-5"
    assert data["skill_ids"] == []
    assert data["platform_skill_refs"][0]["version"] == "1.0.0"
    assert data["category"] == "marketing"
    assert data["avatar_url"] == "https://example.com/a.png"
    assert data["description"] == "营销高管"
    # backfill：persona/model + 固定平台技能引用供 Manager 招募时安装。
    assert data["persona"] == "You are CMO"
    assert data["recommended_config"].get("model") == "gpt-5"
    assert data["recommended_config"].get("skills") == ["00000000-0000-0000-0000-000000000101"]
    assert data["recommended_config"].get("platform_skill_refs")[0]["content_hash"] == "abc123"


def test_pull_expert_template_defaults_when_unset(client):
    """F06：未选择头像或平台技能时返回空默认值。"""
    _register_and_publish_expert(client)

    r = client.get(
        "/api/operation/catalog/pull/expert-templates/tpl-cmo",
        headers=_service_auth(),
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["system_prompt"] == "marketing leader"
    assert data["default_model"] == "gpt-5"
    assert data["skill_ids"] == []
    assert data["platform_skill_refs"] == []
    assert data["category"] == "marketing"

def test_pull_expert_template_prd_required_rejected(client):
    """F06：PRD 必填字段缺失的注册请求应在 schema 层被拒（422），不入库。"""
    from shared.contracts.enums import PlatformRole

    def _token(role: str = PlatformRole.SYSTEM_OPERATOR.value) -> str:
        from operation_service.app import _auth
        from shared.contracts.auth import TokenClaims
        return _auth.signer.sign(TokenClaims(user_id="op1", roles=[role], exp=9999999999))

    def _auth_header(role: str = PlatformRole.SYSTEM_OPERATOR.value) -> dict:
        return {"Authorization": f"Bearer {_token(role)}"}

    body = {"display_name": "Only Name"}
    r = client.post("/api/operation/catalog/expert-templates", json=body, headers=_auth_header())
    assert r.status_code == 422, r.text


def test_list_expert_templates_include_flat_config(client):
    """F06：列举可招募专家模板时透传 PRD-v2 扁平字段。"""
    _register_expert_with_full_config(client)

    r = client.get(
        "/api/operation/catalog/pull/expert-templates",
        headers=_service_auth(),
    )
    assert r.status_code == 200
    data = r.json()["data"]
    item = next(i for i in data if i["template_id"] == "tpl-full")
    assert item["system_prompt"] == "You are CMO"
    assert item["default_model"] == "gpt-5"
    assert item["skill_ids"] == []
    assert item["platform_skill_refs"][0]["skill_id"] == "00000000-0000-0000-0000-000000000101"
    assert item["category"] == "marketing"
    assert item["persona"] == "You are CMO"
    assert item["description"] == "营销高管"
    assert item["recommended_config"].get("model") == "gpt-5"
# ---- Issue #285：方案包拉取透传专家绑定排序号与启用开关 ----

def test_pull_solution_package_includes_binding_metadata(client):
    """F07：拉取方案包时，专家绑定排序号与启用开关应透传（issue #285 修复验证）。"""
    _register_solution_with_bindings(client)

    r = client.get(
        "/api/operation/catalog/pull/solution-templates/sol-bound",
        headers=_service_auth(),
    )
    assert r.status_code == 200
    experts = r.json()["data"]["experts"]
    by_id = {e["template_id"]: e for e in experts}
    assert by_id["tpl-ceo"]["sequence_no"] == 1
    assert by_id["tpl-ceo"]["enabled"] is True
    assert by_id["tpl-cmo"]["sequence_no"] == 2
    assert by_id["tpl-cmo"]["enabled"] is False

def test_pull_solution_package_flat_ids_default_binding_metadata(client):
    """回退路径：仅 expert_template_ids 注册时，拉取应返回默认 sequence_no/enabled。"""
    _register_and_publish_solution(client)

    r = client.get(
        "/api/operation/catalog/pull/solution-templates/sol-marketing",
        headers=_service_auth(),
    )
    assert r.status_code == 200
    experts = r.json()["data"]["experts"]
    assert experts[0]["template_id"] == "tpl-cmo"
    assert experts[0]["sequence_no"] == 1
    assert experts[0]["enabled"] is True
