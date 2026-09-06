"""招募/应用方案 HTTP 路由验收（M6，02 §10/§11；非 integration，不依赖 PG）。

非 integration：受保护端点无 token → 401；未配置 DB → 503（problem+json，不静默）。
integration（真 PG）的端到端 CRUD 留 reviewer 环境（与本卡 mock Operator 无关，单测已覆盖编排）。
"""

from __future__ import annotations

from fastapi.testclient import TestClient
import pytest
from unittest.mock import MagicMock, patch

from shared.config import Settings
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token

# 无 DB 非集成测试用固定 RSA key 的 inmem verifier/signer（与 app 真实 DynamicRS256 同源逻辑，
# 仅密钥源不同：测试用内存固定 key，生产用 TenantKeyStore/admin 连接）。
_INMEM_VERIFIER, _INMEM_SIGNER = make_inmem_verifier_and_signer()


def _client(db_url: str | None) -> TestClient:
    """重建 app（注入 settings + 测试 inmem verifier），挂全部业务路由含 recruit。"""
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.routes_recruit import build_recruit_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    settings = Settings(
        tier="manager", service_name="aiteam-manager-service", db_url=db_url,
    )
    app = create_app(settings, manager_router)
    app.state._token_verifier = _INMEM_VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(auth_router)
    app.include_router(build_employee_router(_INMEM_VERIFIER))
    app.include_router(build_recruit_router(_INMEM_VERIFIER))
    return TestClient(app)


def test_recruit_expert_without_token_returns_401():
    """受保护端点无 Authorization 头 → 401 problem+json（03 §9.6）。"""
    client = _client(None)
    resp = client.post(
        "/api/manager/recruit/experts",
        json={"template_id": "tpl-1", "employee_slug": "exp-a"},
    )
    assert resp.status_code == 401
    assert resp.headers["content-type"].startswith("application/problem+json")


def test_apply_solution_without_token_returns_401():
    client = _client(None)
    resp = client.post(
        "/api/manager/recruit/solutions",
        json={"solution_id": "sol-1"},
    )
    assert resp.status_code == 401


def test_recruit_and_apply_reject_malformed_audience_before_service_call():
    service = MagicMock()
    with patch("manager_service.routes_recruit._service", return_value=service):
        client = _client("postgresql://fake/fake")
        header = _auth_header()
        recruit = client.post("/api/manager/recruit/experts", headers=header,
                              json={"template_id": "tpl-1", "department_ids": ["not-a-uuid"]})
        apply = client.post("/api/manager/recruit/solutions", headers=header,
                            json={"solution_id": "sol-1", "member_ids": ["not-a-uuid"]})
    assert recruit.status_code == 422 and apply.status_code == 422
    assert service.mock_calls == []


def test_recruit_expert_unconfigured_db_returns_503():
    """未配置业务 DB → 503 problem+json（不静默放行，与 employee/auth 路由一致）。"""
    import uuid

    client = _client(None)
    token = sign_inmem_token(_INMEM_SIGNER, str(uuid.uuid4()), ["owner"])
    resp = client.post(
        "/api/manager/recruit/experts",
        json={"template_id": "tpl-1", "employee_slug": "exp-a"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 503
    assert resp.headers["content-type"].startswith("application/problem+json")
    body = resp.json()
    assert body["code"] == "manager_db_unconfigured"


def test_list_solution_instances_without_token_returns_401():
    client = _client(None)
    resp = client.get("/api/manager/recruit/solutions")
    assert resp.status_code == 401


# ---- 目录浏览（F06/F07 browse，#118）：纯 Operator 目录只读，不依赖 DB ----


def _auth_header():
    import uuid

    token = sign_inmem_token(_INMEM_SIGNER, str(uuid.uuid4()), ["owner"])
    return {"Authorization": f"Bearer {token}"}


def test_browse_experts_without_token_returns_401():
    client = _client(None)
    resp = client.get("/api/manager/recruit/catalog/experts")
    assert resp.status_code == 401


def test_browse_solutions_without_token_returns_401():
    client = _client(None)
    resp = client.get("/api/manager/recruit/catalog/solutions")
    assert resp.status_code == 401


def test_browse_experts_returns_seeded_templates():
    """seed Operator 目录 → GET 合并本租户招募状态。"""
    from shared.contracts.crosstier import ExpertTemplateDetail

    service = MagicMock()
    service.recruited_template_ids.return_value = {"tpl-1"}
    with patch("manager_service.routes_recruit.build_recruit_service", return_value=service):
        client = _client("postgresql://fake/fake")
        client.app.state._operator_catalog.seed_expert(
            ExpertTemplateDetail(template_id="tpl-1", version="1", display_name="测试专家", platform_model_ref={"provider_id": "p1", "provider_version": 1, "model_id": "m1", "model_version": 1})
        )
        resp = client.get("/api/manager/recruit/catalog/experts", headers=_auth_header())
    assert resp.status_code == 200, resp.text
    items = resp.json()["data"]
    assert len(items) == 1
    assert items[0]["template_id"] == "tpl-1"
    assert items[0]["display_name"] == "测试专家"
    assert items[0]["is_recruited"] is True


def test_browse_solutions_returns_seeded_packages():
    from shared.contracts.crosstier import SolutionPackage

    client = _client(None)
    client.app.state._operator_catalog.seed_solution(
        SolutionPackage(solution_id="sol-1", version="1", display_name="测试方案")
    )
    resp = client.get("/api/manager/recruit/catalog/solutions", headers=_auth_header())
    assert resp.status_code == 200, resp.text
    items = resp.json()["data"]
    assert len(items) == 1
    assert items[0]["solution_id"] == "sol-1"


def test_browse_experts_empty_when_unseeded():
    """未 seed → 空列表（不报错）。"""
    service = MagicMock()
    service.recruited_template_ids.return_value = set()
    with patch("manager_service.routes_recruit.build_recruit_service", return_value=service):
        client = _client("postgresql://fake/fake")
        resp = client.get("/api/manager/recruit/catalog/experts", headers=_auth_header())
    assert resp.status_code == 200
    assert resp.json()["data"] == []


def test_browse_experts_keeps_templates_when_platform_catalog_is_unavailable():
    """尚未初始化 Operator 网关时，浏览目录仍可展示模板。"""
    from shared.contracts.crosstier import ExpertTemplateDetail
    from shared.errors import AppError
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    class UnavailableCatalog(FakeOperatorCatalogClient):
        def list_platform_catalog(self, *, tenant_id=None):
            raise AppError("gateway not bootstrapped")

    service = MagicMock()
    service.recruited_template_ids.return_value = set()
    with patch("manager_service.routes_recruit.build_recruit_service", return_value=service):
        client = _client("postgresql://fake/fake")
        client.app.state._operator_catalog = UnavailableCatalog()
        client.app.state._operator_catalog.seed_expert(
            ExpertTemplateDetail(
                template_id="tpl-1", version="1", display_name="测试专家",
                platform_model_ref={
                    "provider_id": "p1", "provider_version": 1,
                    "model_id": "m1", "model_version": 1,
                },
            )
        )
        resp = client.get("/api/manager/recruit/catalog/experts", headers=_auth_header())
    assert resp.status_code == 200, resp.text
    assert [item["template_id"] for item in resp.json()["data"]] == ["tpl-1"]


def test_browse_catalog_supports_legacy_signature_and_propagates_client_errors():
    from manager_service.routes_recruit import _list_platform_catalog
    from shared.errors import NotFound

    class LegacyCatalog:
        def list_platform_catalog(self):
            return {"providers": [], "models": []}

    assert _list_platform_catalog(LegacyCatalog(), "tenant-1")["models"] == []

    class MissingCatalog:
        def list_platform_catalog(self, *, tenant_id):
            raise NotFound(f"tenant not found: {tenant_id}")

    with pytest.raises(NotFound, match="tenant not found"):
        _list_platform_catalog(MissingCatalog(), "tenant-1")


def test_browse_experts_filters_unopened_models():
    from shared.contracts.crosstier import ExpertTemplateDetail
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    def expert(template_id, model_id):
        return ExpertTemplateDetail(
            template_id=template_id, version="1", display_name=template_id,
            platform_model_ref={
                "provider_id": "p1", "provider_version": 1,
                "model_id": model_id, "model_version": 1,
            },
        )

    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(expert("allowed", "m1"))
    catalog.seed_expert(expert("blocked", "m2"))
    catalog.seed_platform_catalog({
        "model_access_configured": True,
        "models": [{"model": {"provider_id": "p1", "model_id": "m1"}}],
    })
    service = MagicMock()
    service.recruited_template_ids.return_value = set()
    with patch("manager_service.routes_recruit.build_recruit_service", return_value=service):
        client = _client("postgresql://fake/fake")
        client.app.state._operator_catalog = catalog
        resp = client.get("/api/manager/recruit/catalog/experts", headers=_auth_header())

    assert resp.status_code == 200, resp.text
    assert [item["template_id"] for item in resp.json()["data"]] == ["allowed"]


def test_browse_solutions_filters_unopened_models():
    from shared.contracts.crosstier import ExpertTemplateDetail, SolutionPackage
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    def expert(template_id, model_id):
        return ExpertTemplateDetail(
            template_id=template_id, version="1", display_name=template_id,
            platform_model_ref={
                "provider_id": "p1", "provider_version": 1,
                "model_id": model_id, "model_version": 1,
            },
        )

    catalog = FakeOperatorCatalogClient()
    catalog.seed_solution(SolutionPackage(
        solution_id="allowed", version="1", display_name="Allowed",
        experts=[expert("tpl-allowed", "m1")],
    ))
    catalog.seed_solution(SolutionPackage(
        solution_id="blocked", version="1", display_name="Blocked",
        experts=[expert("tpl-blocked", "m2")],
    ))
    catalog.seed_platform_catalog({
        "model_access_configured": True,
        "models": [{"model": {"provider_id": "p1", "model_id": "m1"}}],
    })
    client = _client(None)
    client.app.state._operator_catalog = catalog
    response = client.get("/api/manager/recruit/catalog/solutions", headers=_auth_header())

    assert response.status_code == 200, response.text
    assert [item["solution_id"] for item in response.json()["data"]] == ["allowed"]


def test_browse_experts_unconfigured_db_returns_503():
    client = _client(None)
    resp = client.get("/api/manager/recruit/catalog/experts", headers=_auth_header())
    assert resp.status_code == 503
    assert resp.json()["code"] == "manager_db_unconfigured"
