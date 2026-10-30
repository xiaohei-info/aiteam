"""人才市场字段细化（议题 7）：Operator 专家模板展示字段的注册、编辑、清除与 F06 投影。

旧模板（payload 无这些字段）必须仍合法并按默认值读取。
"""

import pytest
from fastapi.testclient import TestClient

from operation_service.catalog_dependencies import get_catalog_service
from operation_service.catalog_gateway import CatalogManagerGateway
from operation_service.catalog_repository import CatalogEntry, CatalogRepository
from operation_service.catalog_service import CatalogService
from run import get_app
from shared.contracts.auth import TokenClaims
from shared.contracts.enums import CatalogStatus, CatalogType, PlatformRole
from shared.contracts.expert_profile import profile_from_payload

_MODEL_REF = {"provider_id": "provider-1", "provider_version": 1, "model_id": "gpt-5", "model_version": 1}
_PROFILE = {
    "tagline": "帮你把市场数据变成周报",
    "use_cases": ["竞品周报", "投放复盘"],
    "limitations": ["不做财务审计"],
    "example_prompts": ["整理本周投放数据"],
    "sample_outputs": [{"title": "周报样例", "output_type": "document", "preview_url": "https://example.com/r.pdf"}],
    "output_types": ["document", "spreadsheet", "document"],
    "required_connectors": ["feishu"],
    "optional_connectors": ["notion"],
    "recommended_knowledge": ["产品手册"],
    "required_permissions": {"full_access": False, "local_directories": True},
    "pricing": {"mode": "per_call", "unit_price": "0.05"},
    "memory_policy_summary": "保存对话记忆，可随时清除",
    "publisher": "平台运营",
    "changelog_url": "https://example.com/changelog",
}


class _Gateway(CatalogManagerGateway):
    def notify_catalog_release(self, notify, *, idempotency_key):
        return None


class _Providers:
    def validate_model_ref(self, ref, *, require_published=False):
        return ref


@pytest.fixture
def client():
    app = get_app("operation")
    service = CatalogService(CatalogRepository(), _Gateway(), platform_providers=_Providers())
    app.dependency_overrides[get_catalog_service] = lambda: service
    client = TestClient(app)
    client.catalog_service = service
    yield client
    app.dependency_overrides.clear()


def _auth() -> dict:
    from operation_service.app import _auth as auth

    token = auth.signer.sign(TokenClaims(user_id="op1", roles=[PlatformRole.SYSTEM_OPERATOR.value], exp=9999999999))
    return {"Authorization": f"Bearer {token}"}


def _expert(**extra) -> dict:
    return {
        "template_id": "tpl-mkt", "display_name": "市场分析师", "category": "marketing",
        "system_prompt": "lead", "platform_model_ref": _MODEL_REF, "description": "市场数据分析", **extra,
    }


def _register(client, body):
    return client.post("/api/operation/catalog/expert-templates", json=body, headers=_auth())


def test_register_persists_profile_fields_and_stamps_updated_at(client):
    response = _register(client, _expert(**_PROFILE))
    assert response.status_code == 201, response.text
    data = response.json()["data"]
    assert data["tagline"] == _PROFILE["tagline"]
    assert data["output_types"] == ["document", "spreadsheet"]
    assert data["pricing"] == {"mode": "per_call", "unit_price": "0.05", "currency": "USD"}
    assert data["required_permissions"] == {"full_access": False, "local_directories": True}
    assert data["updated_at"] is not None

    detail = client.get("/api/operation/catalog/expert_template/tpl-mkt", headers=_auth()).json()["data"]
    assert detail["sample_outputs"][0]["preview_url"] == "https://example.com/r.pdf"
    assert detail["publisher"] == "平台运营"


def test_published_pull_and_list_project_profile_fields(client):
    assert _register(client, _expert(**_PROFILE)).status_code == 201
    service: CatalogService = client.catalog_service
    from operation_service.catalog_schemas import PublishTemplateRequest

    service.publish_template(CatalogType.EXPERT_TEMPLATE, "tpl-mkt", PublishTemplateRequest())
    pulled = service.pull_expert_template_detail(template_id="tpl-mkt")
    assert pulled.tagline == _PROFILE["tagline"]
    assert pulled.use_cases == _PROFILE["use_cases"]
    assert pulled.pricing is not None and str(pulled.pricing.unit_price) == "0.05"
    assert pulled.updated_at is not None
    [listed] = service.list_published_expert_templates()
    assert listed.required_connectors == ["feishu"]
    assert listed.model_dump(mode="json")["pricing"]["unit_price"] == "0.05"


def test_legacy_template_without_profile_fields_reads_defaults(client):
    service: CatalogService = client.catalog_service
    service._repo.create(CatalogEntry(
        catalog_type=CatalogType.EXPERT_TEMPLATE, template_id="tpl-old", version="3", display_name="旧模板",
        status=CatalogStatus.PUBLISHED,
        payload={"category": "x", "system_prompt": "p", "platform_model_ref": _MODEL_REF, "description": "d"},
    ))
    pulled = service.pull_expert_template_detail(template_id="tpl-old")
    assert pulled.tagline == "" and pulled.use_cases == [] and pulled.pricing is None
    assert pulled.required_permissions is None and pulled.updated_at is None
    detail = client.get("/api/operation/catalog/expert_template/tpl-old", headers=_auth()).json()["data"]
    assert detail["output_types"] == [] and detail["updated_at"] is None


def test_dirty_profile_field_falls_back_without_dropping_others():
    profile = profile_from_payload({"tagline": "ok", "pricing": {"mode": "bogus", "unit_price": "1"}, "output_types": ["code"]})
    assert profile.tagline == "ok"
    assert profile.output_types == ["code"]
    assert profile.pricing is None


def test_patch_updates_and_clears_profile_fields(client):
    assert _register(client, _expert(**_PROFILE)).status_code == 201
    response = client.patch(
        "/api/operation/catalog/expert_template/tpl-mkt",
        json={"tagline": "新定位", "use_cases": ["日报"], "pricing": None},
        headers=_auth(),
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["tagline"] == "新定位"
    assert data["use_cases"] == ["日报"]
    assert data["pricing"] is None
    # 省略的可清除字段保持不变。
    assert data["required_permissions"] == {"full_access": False, "local_directories": True}

    response = client.patch(
        "/api/operation/catalog/expert_template/tpl-mkt",
        json={"pricing": {"mode": "per_token", "unit_price": "2.5"}}, headers=_auth(),
    )
    assert response.json()["data"]["pricing"] == {"mode": "per_token", "unit_price": "2.5", "currency": "USD"}


@pytest.mark.parametrize("bad", [
    {"tagline": "长" * 41},
    {"use_cases": ["长" * 31]},
    {"use_cases": ["a", "b", "c", "d", "e", "f", "g"]},
    {"limitations": ["a", "b", "c", "d"]},
    {"example_prompts": ["a", "b", "c", "d"]},
    {"output_types": ["video"]},
    {"changelog_url": "javascript:alert(1)"},
    {"sample_outputs": [{"title": "x", "output_type": "document", "preview_url": "data:text/html,x"}]},
    {"pricing": {"mode": "per_call", "unit_price": "-1"}},
    {"pricing": {"mode": "per_call", "unit_price": "1", "currency": "CNY"}},
])
def test_register_rejects_invalid_profile_fields(client, bad):
    response = _register(client, _expert(**bad))
    assert response.status_code == 422, response.text


def test_patch_rejects_invalid_profile_field(client):
    assert _register(client, _expert()).status_code == 201
    response = client.patch(
        "/api/operation/catalog/expert_template/tpl-mkt", json={"changelog_url": "ftp://x"}, headers=_auth(),
    )
    assert response.status_code == 422


def test_solution_template_rejects_profile_fields(client):
    assert _register(client, _expert()).status_code == 201
    body = {"solution_id": "sol-x", "display_name": "X", "description": "d", "expert_template_ids": ["tpl-mkt"], "coordinator_template_id": "tpl-mkt"}
    assert client.post("/api/operation/catalog/solution-templates", json=body, headers=_auth()).status_code == 201
    response = client.patch("/api/operation/catalog/solution_template/sol-x", json={"tagline": "x"}, headers=_auth())
    assert response.status_code == 422
