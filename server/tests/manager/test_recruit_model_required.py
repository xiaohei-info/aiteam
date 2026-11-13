"""R6：招募 / 应用方案必须由企业显式选模型；模型校验失败时零写入。"""

from __future__ import annotations

import copy

import pytest

from manager_service.recruit_model_guard import ModelRequired, ModelUnavailable
from manager_service.schemas import ApplySolutionRequest, RecruitExpertRequest, RecruitModelPolicy
from tests.manager._recruit_model import (
    EXPERT_MODELS, MODEL, MODEL_POLICY, PROVIDER, platform_catalog_with_model,
)
from tests.manager.test_recruit_solution import (
    FakeOperatorCatalogClient, _build_service, _ctx, _expert_template, _solution_package,
)

OTHER = "other-model"


def _catalog(mutate=None, *, with_other=False):
    catalog = FakeOperatorCatalogClient()
    data = platform_catalog_with_model()
    if with_other:
        second = copy.deepcopy(data["models"][0])
        second["model"]["model_id"] = OTHER
        data["models"].append(second)
    if mutate:
        mutate(data)
    catalog.seed_platform_catalog(data)
    return catalog


def _row(emp, employee_id):
    row = emp.get(_ctx("t-a"), employee_id=employee_id)
    assert row is not None
    return row


def _recruit(svc, policy):
    return svc.recruit_expert(
        _ctx("t-a"), RecruitExpertRequest(model_policy=policy, template_id="tpl-1", employee_slug="exp-a"),
    )


def _assert_zero_writes(emp, orders):
    assert emp._bucket(_ctx("t-a")) == {}
    assert orders.list_orders(_ctx("t-a")) == []


@pytest.mark.parametrize("policy", [
    RecruitModelPolicy(provider_ref="", model=""),
    RecruitModelPolicy(provider_ref=PROVIDER, model="   "),
    RecruitModelPolicy(provider_ref="", model=MODEL),
])
def test_recruit_without_model_is_422_model_required_and_writes_nothing(policy):
    catalog = _catalog()
    catalog.seed_expert(_expert_template())
    svc, emp, _, _, orders = _build_service(catalog)
    with pytest.raises(ModelRequired) as exc:
        _recruit(svc, policy)
    assert exc.value.status == 422 and exc.value.code == "model_required"
    _assert_zero_writes(emp, orders)


def _unknown_model(data):
    data["models"][0]["model"]["model_id"] = "someone-elses-model"


def _draft_model(data):
    data["models"][0]["model"]["status"] = "draft"


def _unpriced_model(data):
    data["models"][0]["rate"]["pricing_status"] = "unknown"


def _unpublished_provider(data):
    data["providers"][0]["status"] = "draft"


def _no_such_provider(data):
    data["providers"] = []


@pytest.mark.parametrize("mutate", [
    _unknown_model, _draft_model, _unpriced_model, _unpublished_provider, _no_such_provider,
])
def test_recruit_with_unavailable_model_is_422_model_unavailable_and_writes_nothing(mutate):
    catalog = _catalog(mutate)
    catalog.seed_expert(_expert_template())
    svc, emp, _, _, orders = _build_service(catalog)
    with pytest.raises(ModelUnavailable) as exc:
        _recruit(svc, MODEL_POLICY)
    assert exc.value.status == 422 and exc.value.code == "model_unavailable"
    _assert_zero_writes(emp, orders)


def test_recruit_model_comes_from_request_not_template():
    catalog = _catalog(with_other=True)
    catalog.seed_expert(_expert_template())  # 模板上的模型是 MODEL / thinking_level=high
    svc, emp, *_ = _build_service(catalog)
    result = _recruit(svc, RecruitModelPolicy(provider_ref=PROVIDER, model=OTHER))
    row = _row(emp, result.employee_id)
    assert (row.provider_ref, row.model) == (PROVIDER, OTHER)
    assert row.platform_model_ref == {"provider_id": PROVIDER, "model_id": OTHER}
    assert row.thinking_level is None


def test_apply_solution_missing_new_expert_model_fails_whole_order_with_per_expert_errors():
    catalog = _catalog()
    catalog.seed_solution(_solution_package())
    svc, emp, _, recruit, orders = _build_service(catalog)
    with pytest.raises(ModelRequired) as exc:
        svc.apply_solution(
            _ctx("t-a"),
            ApplySolutionRequest(solution_id="sol-1", expert_models={"tpl-a": MODEL_POLICY}),
        )
    assert exc.value.status == 422
    assert [e.loc for e in exc.value.errors] == [["body", "expert_models", "tpl-b"]]
    _assert_zero_writes(emp, orders)


def test_apply_solution_lists_every_failing_expert():
    catalog = _catalog()
    catalog.seed_solution(_solution_package())
    svc, emp, _, _, orders = _build_service(catalog)
    bad = RecruitModelPolicy(provider_ref=PROVIDER, model="nope")
    with pytest.raises(ModelUnavailable) as exc:
        svc.apply_solution(
            _ctx("t-a"),
            ApplySolutionRequest(solution_id="sol-1", expert_models={"tpl-a": bad, "tpl-b": bad}),
        )
    assert sorted(e.loc[-1] for e in exc.value.errors) == ["tpl-a", "tpl-b"]
    _assert_zero_writes(emp, orders)


def test_apply_solution_can_change_model_of_reused_expert_and_bumps_version():
    catalog = _catalog(with_other=True)
    package = _solution_package()
    catalog.seed_solution(package)
    for expert in package.experts:
        catalog.seed_expert(expert)
    svc, emp, *_ = _build_service(catalog)
    existing = svc.recruit_expert(
        _ctx("t-a"), RecruitExpertRequest(model_policy=MODEL_POLICY, template_id="tpl-a", employee_slug="programmer"),
    )
    before = _row(emp, existing.employee_id)
    models = {**EXPERT_MODELS, "tpl-a": RecruitModelPolicy(provider_ref=PROVIDER, model=OTHER)}
    svc.apply_solution(_ctx("t-a"), ApplySolutionRequest(solution_id="sol-1", expert_models=models))
    after = _row(emp, existing.employee_id)
    assert after.model == OTHER and after.version == before.version + 1


def test_apply_solution_keeps_reused_expert_model_when_not_requested():
    catalog = _catalog()
    package = _solution_package()
    catalog.seed_solution(package)
    for expert in package.experts:
        catalog.seed_expert(expert)
    svc, emp, *_ = _build_service(catalog)
    existing = svc.recruit_expert(
        _ctx("t-a"), RecruitExpertRequest(model_policy=MODEL_POLICY, template_id="tpl-a", employee_slug="programmer"),
    )
    before = _row(emp, existing.employee_id)
    svc.apply_solution(
        _ctx("t-a"), ApplySolutionRequest(solution_id="sol-1", expert_models={"tpl-b": MODEL_POLICY}),
    )
    assert _row(emp, existing.employee_id).version == before.version
