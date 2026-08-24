"""SolutionApplyRecord 方案应用记录验收（AITEAM-242，issue #286 gap）。

覆盖：
- F07 应用方案后持久化 SolutionApplyRecord（applied_by / applied_at / solution_version / status / expert_instances_created）。
- list / get_latest 查询 + 跨 tenant 隔离（D22）。
"""

from __future__ import annotations

import pytest

from shared.contracts.crosstier import ExpertTemplateDetail, SolutionPackage
from shared.contracts.platform_provider import PlatformModelRef
from shared.contracts.tenancy import TenantContext

from manager_service.recruit_service import RecruitService
from manager_service.schemas import ApplySolutionRequest


def _ctx(tid: str, roles=None) -> TenantContext:
    return TenantContext(tenant_id=tid, user_id="u-1", roles=roles or ["owner"])


def _ref(model):
    return PlatformModelRef(provider_id="provider-1", provider_version=1, model_id=model, model_version=1)


def _solution_package(solution_id="sol-1", version="v1") -> SolutionPackage:
    return SolutionPackage(
        solution_id=solution_id, version=version, display_name="行业方案A",
        experts=[
            ExpertTemplateDetail(
                template_id="tpl-a", version="v1", display_name="专家甲", platform_model_ref=_ref("m-a"),
                persona="你是甲", recommended_config={"model": "m-a", "skills": ["s-a"]},
            ),
            ExpertTemplateDetail(
                template_id="tpl-b", version="v1", display_name="专家乙", platform_model_ref=_ref("m-b"),
                persona="你是乙", recommended_config={"model": "m-b", "knowledge_refs": ["ks-b"]},
            ),
        ],
        knowledge_refs=["ks-shared"],
        skill_refs=["skill-shared"],
        default_grants={"department_ids": ["dept-default"]},
    )


def test_apply_solution_persists_solution_apply_record():
    """F07 主路径：应用方案后写一条 SolutionApplyRecord（applied_by / version / status / experts）。"""
    from tests.manager.test_recruit_solution import (  # shared fakes
        _build_service,
    )
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    catalog = FakeOperatorCatalogClient()
    catalog.seed_solution(_solution_package())
    svc, _, _, recruit, _ = _build_service(catalog)

    result = svc.apply_solution(_ctx("t-a"), ApplySolutionRequest(solution_id="sol-1"))
    expert_ids = result.solution_instance.expert_employee_ids

    latest = svc.get_latest_solution_apply_record(_ctx("t-a"), solution_id="sol-1")
    assert latest is not None
    assert latest.solution_id == "sol-1"
    assert latest.solution_version == "v1"
    assert latest.status == "applied"
    assert latest.applied_by == "u-1"
    assert set(latest.expert_instance_ids) == set(expert_ids)

    repo_rows = recruit.list_solution_apply_records(_ctx("t-a"))
    assert len(repo_rows) == 1
    assert repo_rows[0].solution_id == "sol-1"
    assert repo_rows[0].status == "applied"


def test_list_solution_apply_records_filters_by_solution_and_status():
    from tests.manager.test_recruit_solution import _build_service
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    catalog = FakeOperatorCatalogClient()
    catalog.seed_solution(_solution_package(solution_id="sol-a", version="v1"))
    catalog.seed_solution(_solution_package(solution_id="sol-b", version="v1"))
    svc, _, _, recruit, _ = _build_service(catalog)

    svc.apply_solution(_ctx("t-a"), ApplySolutionRequest(solution_id="sol-a"))
    svc.apply_solution(_ctx("t-a"), ApplySolutionRequest(solution_id="sol-b"))

    all_rows = svc.list_solution_apply_records(_ctx("t-a"))
    assert len(all_rows) == 2

    only_a = svc.list_solution_apply_records(_ctx("t-a"), solution_id="sol-a")
    assert len(only_a) == 1
    assert only_a[0].solution_id == "sol-a"

    only_applied = recruit.list_solution_apply_records(_ctx("t-a"), status="applied")
    assert len(only_applied) == 2

    only_revoked = recruit.list_solution_apply_records(_ctx("t-a"), status="revoked")
    assert only_revoked == []


def test_apply_record_is_tenant_isolated():
    from tests.manager.test_recruit_solution import _build_service
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    catalog = FakeOperatorCatalogClient()
    catalog.seed_solution(_solution_package())
    svc, _, _, recruit, _ = _build_service(catalog)

    svc.apply_solution(_ctx("t-a"), ApplySolutionRequest(solution_id="sol-1"))

    assert recruit.list_solution_apply_records(_ctx("t-b")) == []
    with pytest.raises(Exception):
        svc.get_latest_solution_apply_record(_ctx("t-b"), solution_id="sol-1")


def test_apply_record_latest_picks_most_recent_applied():
    from tests.manager.test_recruit_solution import _build_service
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    catalog = FakeOperatorCatalogClient()
    catalog.seed_solution(_solution_package(solution_id="sol-1", version="v1"))
    catalog.seed_solution(_solution_package(solution_id="sol-1", version="v2"))
    svc, _, _, recruit, _ = _build_service(catalog)

    svc.apply_solution(_ctx("t-a"), ApplySolutionRequest(solution_id="sol-1", solution_version="v1"))
    svc.apply_solution(_ctx("t-a"), ApplySolutionRequest(solution_id="sol-1", solution_version="v2"))

    latest = svc.get_latest_solution_apply_record(_ctx("t-a"), solution_id="sol-1")
    assert latest.solution_version == "v2"
    assert latest.status == "applied"
