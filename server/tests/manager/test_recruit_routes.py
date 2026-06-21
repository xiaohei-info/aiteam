"""招募/应用方案 HTTP 路由验收（M6，02 §10/§11；非 integration，不依赖 PG）。

非 integration：受保护端点无 token → 401；未配置 DB → 503（problem+json，不静默）。
integration（真 PG）的端到端 CRUD 留 reviewer 环境（与本卡 mock Operator 无关，单测已覆盖编排）。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from shared.config import Settings


def _client(db_url: str | None) -> TestClient:
    """重建 app（注入 settings），挂全部业务路由含 recruit。catalog 默认 Fake（app.state 注入）。"""
    from shared.app_factory import create_app
    from manager_service.app import (
        router as manager_router,
        _verifier,
    )
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.routes_recruit import build_recruit_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    settings = Settings(
        tier="manager", service_name="aiteam-manager-service", db_url=db_url,
    )
    app = create_app(settings, manager_router)
    app.state._token_verifier = _verifier
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(auth_router)
    app.include_router(build_employee_router(_verifier))
    app.include_router(build_recruit_router(_verifier))
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


def test_recruit_expert_unconfigured_db_returns_503():
    """未配置业务 DB → 503 problem+json（不静默放行，与 employee/auth 路由一致）。"""
    from shared.auth import DevTokenService
    from shared.contracts.auth import TokenClaims
    import uuid

    client = _client(None)
    token = DevTokenService().sign(
        TokenClaims(
            tenant_id=str(uuid.uuid4()), user_id="u", roles=["owner"], exp=9999999999,
        )
    )
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
    from shared.auth import DevTokenService
    from shared.contracts.auth import TokenClaims
    import uuid

    token = DevTokenService().sign(
        TokenClaims(tenant_id=str(uuid.uuid4()), user_id="u", roles=["owner"], exp=9999999999)
    )
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
    """seed Operator 目录 → GET 列出可招募专家模板（不依赖 DB）。"""
    from shared.contracts.crosstier import ExpertTemplateDetail

    client = _client(None)  # browse 不碰租户 DB，无需配置 DB
    client.app.state._operator_catalog.seed_expert(
        ExpertTemplateDetail(template_id="tpl-1", version="1", display_name="测试专家")
    )
    resp = client.get("/api/manager/recruit/catalog/experts", headers=_auth_header())
    assert resp.status_code == 200, resp.text
    items = resp.json()["data"]
    assert len(items) == 1
    assert items[0]["template_id"] == "tpl-1"
    assert items[0]["display_name"] == "测试专家"


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
    client = _client(None)
    resp = client.get("/api/manager/recruit/catalog/experts", headers=_auth_header())
    assert resp.status_code == 200
    assert resp.json()["data"] == []
