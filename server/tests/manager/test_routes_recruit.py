"""routes_recruit 分支覆盖补齐（无 DB 非集成）：experts/solutions expert CRUD。

现有 test_recruit_routes.py 只覆盖 401/503/目录浏览；本文件补齐真 CRUD happy path。
"""
from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.errors import Conflict, NotFound
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from manager_service.schemas import (
    ApplySolutionResult,
    RecruitExpertResult,
    SolutionInstanceOut,
)


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _hdr(roles=("owner",)):
    return {"Authorization": "Bearer " + sign_inmem_token(_SIGNER, "t1", list(roles))}



def _client(db_url):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_recruit import build_recruit_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    app = create_app(Settings(tier="manager", service_name="m", db_url=db_url),
                     manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(build_recruit_router(_VERIFIER))
    app.include_router(build_employee_router(_VERIFIER))
    return TestClient(app)


def _recruit_result():
    return RecruitExpertResult(
        employee_id="emp-1", employee_slug="exp-a",
        display_name="专家 A", persona="p", source_template_id="tpl-1",
        source_template_version="1", grants_applied=False,
    )


def _solution_instance():
    return SolutionInstanceOut(
        id="si-1", solution_id="sol-1", solution_version="1",
        display_name="方案 A", status="active",
    )


def _apply_result():
    return ApplySolutionResult(
        solution_instance=_solution_instance(),
        experts=[_recruit_result()],
        grants_applied=False,
    )


def _fake_svc():
    svc = MagicMock()
    svc.recruit_expert.return_value = _recruit_result()
    svc.apply_solution.return_value = _apply_result()
    svc.list_solution_instances.return_value = [_solution_instance()]
    svc.recruited_template_ids.return_value = set()
    svc.get_solution_instance.return_value = _solution_instance()
    return svc


# ---- 401 ----

@pytest.mark.parametrize("method,path", [
    ("POST", "/api/manager/recruit/experts"),
    ("POST", "/api/manager/recruit/solutions"),
    ("GET", "/api/manager/recruit/solutions"),
    ("GET", "/api/manager/recruit/solutions/si-1"),
])
def test_no_token_401(method, path):
    client = _client(None)
    body = {"template_id": "tpl", "employee_slug": "a"} if path.endswith("experts") and method == "POST" else (
        {"solution_id": "s"} if path.endswith("solutions") and method == "POST" else None)
    r = client.request(method, path, json=body)
    assert r.status_code == 401


# ---- 503 ----

def test_recruit_expert_no_db_503():
    client = _client(None)
    r = client.post("/api/manager/recruit/experts",
                    json={"template_id": "tpl", "employee_slug": "a"},
                    headers=_hdr())
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"


def test_list_solution_instances_no_db_503():
    client = _client(None)
    r = client.get("/api/manager/recruit/solutions", headers=_hdr())
    assert r.status_code == 503


# ---- 422 ----


def test_recruit_expert_missing_template_id_422():
    """必填字段 template_id 缺失 → 422（employee_slug 可选：未传由后端自动生成）。"""
    client = _client('postgresql://fake/fake')
    r = client.post('/api/manager/recruit/experts',
                    json={'employee_slug': 'exp'}, headers=_hdr())
    assert r.status_code == 422




def test_recruit_expert_extra_field_422():
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/recruit/experts",
                    json={"template_id": "tpl", "employee_slug": "a", "bad": 1},
                    headers=_hdr())
    assert r.status_code == 422


def test_apply_solution_extra_field_422():
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/recruit/solutions",
                    json={"solution_id": "s", "bad": 1}, headers=_hdr())
    assert r.status_code == 422


# ---- happy ----

def test_recruit_expert_happy():
    fake = _fake_svc()
    with patch("manager_service.routes_recruit.build_recruit_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/recruit/experts",
                   json={"template_id": "tpl-1", "employee_slug": "exp-a"},
                   headers=_hdr())
        assert r.status_code == 201
        assert r.json()["data"]["employee_id"] == "emp-1"
        # 二次（cache hit）
        r2 = c.post("/api/manager/recruit/experts",
                    json={"template_id": "tpl-1", "employee_slug": "exp-a"},
                    headers=_hdr())
        assert r2.status_code == 201


def test_apply_solution_happy():
    fake = _fake_svc()
    with patch("manager_service.routes_recruit.build_recruit_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/recruit/solutions",
                   json={"solution_id": "sol-1"}, headers=_hdr())
        assert r.status_code == 201
        assert r.json()["data"]["solution_instance"]["id"] == "si-1"


def test_list_solution_instances_happy():
    fake = _fake_svc()
    with patch("manager_service.routes_recruit.build_recruit_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.get("/api/manager/recruit/solutions", headers=_hdr())
        assert r.status_code == 200 and len(r.json()["data"]) == 1


def test_get_solution_instance_happy():
    fake = _fake_svc()
    with patch("manager_service.routes_recruit.build_recruit_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.get("/api/manager/recruit/solutions/si-1", headers=_hdr())
        assert r.status_code == 200 and r.json()["data"]["id"] == "si-1"


# ---- errors ----

def test_get_solution_instance_not_found_404():
    fake = _fake_svc()
    fake.get_solution_instance.side_effect = NotFound("nope")
    with patch("manager_service.routes_recruit.build_recruit_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.get("/api/manager/recruit/solutions/missing", headers=_hdr())
        assert r.status_code == 404


def test_recruit_expert_conflict_409():
    fake = _fake_svc()
    fake.recruit_expert.side_effect = Conflict("dup slug")
    with patch("manager_service.routes_recruit.build_recruit_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/recruit/experts",
                   json={"template_id": "tpl-1", "employee_slug": "dup"},
                   headers=_hdr())
        assert r.status_code == 409


# ---- catalog 浏览（F06/F07） ----

def test_browse_experts_happy():
    """目录浏览合并本租户已招募状态。"""
    from shared.contracts.crosstier import ExpertTemplateDetail

    fake = _fake_svc()
    fake.recruited_template_ids.return_value = {"tpl-1"}
    with patch("manager_service.routes_recruit.build_recruit_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        c.app.state._operator_catalog.seed_expert(
            ExpertTemplateDetail(template_id="tpl-1", version="1", display_name="测试", platform_model_ref={"provider_id": "p1", "provider_version": 1, "model_id": "m1", "model_version": 1})
        )
        r = c.get("/api/manager/recruit/catalog/experts", headers=_hdr())
    assert r.status_code == 200
    assert r.json()["data"][0]["template_id"] == "tpl-1"
    assert r.json()["data"][0]["is_recruited"] is True


def test_browse_experts_no_db_503():
    c = _client(None)
    r = c.get("/api/manager/recruit/catalog/experts", headers=_hdr())
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"


def test_browse_experts_operator_outage_is_bounded_503():
    class OfflineCatalog:
        def list_expert_templates(self):
            raise TimeoutError("operator offline")

    c = _client(None)
    c.app.state._operator_catalog = OfflineCatalog()
    r = c.get("/api/manager/recruit/catalog/experts", headers=_hdr())
    assert r.status_code == 503
    assert r.json()["code"] == "operator_unavailable"


def test_browse_solutions_happy():
    from shared.contracts.crosstier import SolutionPackage
    from shared.contracts.crosstier import SolutionPackage
    c = _client(None)
    c.app.state._operator_catalog.seed_solution(
        SolutionPackage(solution_id="sol-1", version="1", display_name="测试")
    )
    r = c.get("/api/manager/recruit/catalog/solutions", headers=_hdr())
    assert r.status_code == 200
    assert r.json()["data"][0]["solution_id"] == "sol-1"


def test_browse_experts_no_token_401():
    c = _client(None)
    r = c.get("/api/manager/recruit/catalog/experts")
    assert r.status_code == 401


def test_browse_catalog_empty():
    with patch("manager_service.routes_recruit.build_recruit_service", return_value=_fake_svc()):
        c = _client("postgresql://fake/fake")
        r = c.get("/api/manager/recruit/catalog/experts", headers=_hdr())
    assert r.status_code == 200
    assert r.json()["data"] == []
