"""R3 发布范围：结构化 visible_scope、按租户过滤的目录拉取、企业行业 / 标签。"""

import pytest
from pydantic import ValidationError

from operation_service.catalog_repository import CatalogRepository
from operation_service.catalog_schemas import (
    ExpertBinding,
    PublishTemplateRequest,
    RegisterExpertTemplateRequest,
    RegisterSolutionTemplateRequest,
    SetVisibilityRequest,
)
from operation_service.catalog_scope import VisibleScope, normalize_scope, scope_allows
from operation_service.catalog_service import CatalogService
from operation_service.repository import EnterpriseAccount, InMemoryEnterpriseRepository
from shared.contracts.enums import CatalogType
from shared.errors import NotFound


class _Gateway:
    def notify_catalog_release(self, notify, *, idempotency_key):
        pass


def _account(tenant, industry=None, tags=()):
    return EnterpriseAccount(
        enterprise_id=f"ent-{tenant}", tenant_id=tenant, enterprise_name=tenant,
        enterprise_code=None, owner_phone="1", owner_bootstrap_hash="h",
        industry=industry, tags=tuple(tags),
    )


@pytest.fixture
def enterprises():
    repo = InMemoryEnterpriseRepository()
    repo.create(_account("t-mfg", "制造业", ["华东", "KA"]))
    repo.create(_account("t-retail", "零售", ["华南"]))
    repo.create(_account("t-bare"))
    return repo


@pytest.fixture
def service(enterprises):
    return CatalogService(CatalogRepository(), _Gateway(), enterprises=enterprises)


def _expert(service, template_id, scope=None):
    service.register_expert_template(RegisterExpertTemplateRequest(
        template_id=template_id, display_name=template_id, category="c",
        avatar_url="https://example.com/a.png", system_prompt="p", description="d",
        platform_skill_refs=[],
    ))
    service.publish_template(
        CatalogType.EXPERT_TEMPLATE, template_id, PublishTemplateRequest(visible_scope=scope),
    )


# ---- 模型与匹配规则 ----

def test_scope_model_rules():
    assert VisibleScope().mode == "all"
    assert VisibleScope(mode="all", industries=["x"]).industries == []  # all 忽略多余条件
    with pytest.raises(ValidationError):
        VisibleScope(mode="limited")  # 行业与标签都空，非法
    with pytest.raises(ValidationError):
        VisibleScope(mode="limited", tags=["x" * 21])
    with pytest.raises(ValidationError):
        VisibleScope(mode="limited", tags=[str(i) for i in range(11)])
    with pytest.raises(ValidationError):
        VisibleScope.model_validate({"mode": "limited", "tags": ["a"], "tenant_ids": ["t"]})
    assert VisibleScope(mode="limited", tags=[" a ", "a", ""]).tags == ["a"]


def test_legacy_scope_values_mean_all():
    for raw in (None, {}, {"tenant_ids": ["t1"]}, "x", {"mode": "limited"}):
        assert normalize_scope(raw).mode == "all"


def test_scope_matches_industry_or_any_tag():
    scope = {"mode": "limited", "industries": ["制造业"], "tags": ["KA"]}
    assert scope_allows(scope, industry="制造业", tags=[])
    assert scope_allows(scope, industry=None, tags=["KA"])
    assert not scope_allows(scope, industry="零售", tags=["华南"])
    assert not scope_allows(scope, industry=None, tags=[])


# ---- 拉取过滤 ----

def test_list_and_detail_pull_are_filtered_by_tenant(service):
    _expert(service, "open")  # 缺省 = 全部企业
    _expert(service, "mfg-only", VisibleScope(mode="limited", industries=["制造业"]))
    _expert(service, "ka-only", VisibleScope(mode="limited", tags=["KA"]))

    ids = lambda tenant: sorted(i.template_id for i in service.list_published_expert_templates(tenant_id=tenant))
    assert ids("t-mfg") == ["ka-only", "mfg-only", "open"]
    assert ids("t-retail") == ["open"]
    assert ids("t-bare") == ["open"]

    assert service.pull_expert_template_detail(template_id="mfg-only", tenant_id="t-mfg")
    with pytest.raises(NotFound):  # 绕过列表直接按 id 拉取也不行
        service.pull_expert_template_detail(template_id="mfg-only", tenant_id="t-retail")


def test_unknown_tenant_sees_only_public_templates(service):
    _expert(service, "open")
    _expert(service, "mfg-only", VisibleScope(mode="limited", industries=["制造业"]))
    assert [i.template_id for i in service.list_published_expert_templates(tenant_id="ghost")] == ["open"]
    with pytest.raises(NotFound):
        service.pull_expert_template_detail(template_id="mfg-only", tenant_id="ghost")


def test_set_visibility_changes_what_a_tenant_sees(service):
    _expert(service, "x", VisibleScope(mode="limited", industries=["零售"]))
    assert service.list_published_expert_templates(tenant_id="t-mfg") == []
    service.set_visibility(CatalogType.EXPERT_TEMPLATE, "x", SetVisibilityRequest(visible_scope=VisibleScope()))
    assert [i.template_id for i in service.list_published_expert_templates(tenant_id="t-mfg")] == ["x"]


# ---- 方案内专家 ----

def _solution(service, coordinator, experts):
    service.register_solution_template(RegisterSolutionTemplateRequest(
        solution_id="sol", display_name="S", description="d",
        coordinator_template_id=coordinator,
        expert_bindings=[ExpertBinding(template_id=e, sequence_no=i + 1, enabled=True) for i, e in enumerate(experts)],
    ))
    service.publish_template(CatalogType.SOLUTION_TEMPLATE, "sol", PublishTemplateRequest())


def test_solution_hides_invisible_experts_and_reports_count(service):
    _expert(service, "lead")
    _expert(service, "mfg-only", VisibleScope(mode="limited", industries=["制造业"]))
    _solution(service, "lead", ["lead", "mfg-only"])

    full = service.pull_solution_package(solution_id="sol", tenant_id="t-mfg")
    assert [e.template_id for e in full.experts] == ["lead", "mfg-only"] and full.hidden_expert_count == 0

    partial = service.pull_solution_package(solution_id="sol", tenant_id="t-retail")
    assert [e.template_id for e in partial.experts] == ["lead"] and partial.hidden_expert_count == 1


def test_solution_with_invisible_coordinator_is_not_available(service):
    _expert(service, "lead", VisibleScope(mode="limited", industries=["制造业"]))
    _expert(service, "helper")
    _solution(service, "lead", ["lead", "helper"])

    assert service.pull_solution_package(solution_id="sol", tenant_id="t-mfg")
    with pytest.raises(NotFound):
        service.pull_solution_package(solution_id="sol", tenant_id="t-retail")
    assert service.list_published_solution_packages(tenant_id="t-retail") == []
    assert len(service.list_published_solution_packages(tenant_id="t-mfg")) == 1


def test_solution_own_scope_is_enforced(service):
    _expert(service, "lead")
    service.register_solution_template(RegisterSolutionTemplateRequest(
        solution_id="sol", display_name="S", description="d", coordinator_template_id="lead",
        expert_bindings=[ExpertBinding(template_id="lead", sequence_no=1, enabled=True)],
    ))
    service.publish_template(
        CatalogType.SOLUTION_TEMPLATE, "sol",
        PublishTemplateRequest(visible_scope=VisibleScope(mode="limited", industries=["零售"])),
    )
    with pytest.raises(NotFound):
        service.pull_solution_package(solution_id="sol", tenant_id="t-mfg")
    assert service.pull_solution_package(solution_id="sol", tenant_id="t-retail")


# ---- 联想与预计可见企业数 ----

def test_scope_options_and_preview(service):
    assert service.scope_options() == {"industries": ["制造业", "零售"], "tags": ["KA", "华东", "华南"]}
    assert service.preview_scope(VisibleScope()) == 3
    assert service.preview_scope(VisibleScope(mode="limited", industries=["制造业"])) == 1
    assert service.preview_scope(VisibleScope(mode="limited", industries=["零售"], tags=["KA"])) == 2
    assert service.preview_scope(VisibleScope(mode="limited", tags=["不存在"])) == 0


# ---- 企业资料 ----

def test_profile_update_roundtrip(enterprises):
    updated = enterprises.update_profile("ent-t-bare", industry="金融", tags=["A"])
    assert (updated.industry, updated.tags) == ("金融", ("A",))
    assert enterprises.get_by_tenant_id("t-bare").industry == "金融"
    with pytest.raises(NotFound):
        enterprises.update_profile("nope", industry=None, tags=[])
