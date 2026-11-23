"""技能 / 连接器被员工使用时的删除、停用联动（设计 2026-11-22 §3.4）——真 PostgreSQL + RLS。"""

import pytest

from manager_service.capability_catalog_repository import CapabilityCatalogRepository
from manager_service.capability_catalog_service import CapabilityCatalogService, CapabilityInUse
from manager_service.employee_capability_ref_repository import EmployeeCapabilityRefRepository
from manager_service.employee_config_repository import EmployeeConfigRepository
from manager_service.schemas import ConnectorCatalogIn, SkillCatalogIn
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter

pytestmark = pytest.mark.integration


class _Audit:
    def __init__(self):
        self.events = []

    def record(self, ctx, *, actor, action, resource_type=None, resource_id=None, detail=None):
        self.events.append((ctx.tenant_id, actor, action, resource_type, resource_id, detail))


def _ctx(tenant_id):
    return TenantContext(tenant_id=tenant_id, user_id="admin-1", roles=["owner"])


@pytest.fixture()
def env(migrated_db, two_tenants):
    router = PgTenantRouter(migrated_db)
    audit = _Audit()
    svc = CapabilityCatalogService(CapabilityCatalogRepository(router), EmployeeCapabilityRefRepository(router), audit)
    return router, svc, audit, EmployeeConfigRepository(router), CapabilityCatalogRepository(router), two_tenants


def _employee(repo, ctx, slug, *, skills=(), connectors=()):
    return repo.create(
        ctx, employee_slug=slug, display_name=f"员工-{slug}", persona=None, model=None, provider_ref=None,
        thinking_level=None, timeout_seconds=None, tools=[], skills=list(skills), knowledge_refs=[],
        connector_refs=list(connectors), memory_policy=None,
    )


def _skill(catalog, ctx, skill_id="weekly"):
    return catalog.create_skill(
        ctx, skill_id=skill_id, display_name="周报整理", version="1", install_policy="on_demand",
        binding_policy="opt_in", visibility="tenant", config={}, files=[], content_hash="",
    )


def test_delete_requires_a_choice_while_employees_use_the_skill(env):
    router, svc, audit, employees, catalog, (ta, tb) = env
    a, b = _ctx(ta), _ctx(tb)
    skill = _skill(catalog, a)
    e1 = _employee(employees, a, "e1", skills=["weekly", "other"])
    e2 = _employee(employees, a, "e2", skills=["weekly@1"])
    e3 = _employee(employees, a, "e3", skills=["other"])
    _skill(catalog, b)
    other_tenant = _employee(employees, b, "t-b", skills=["weekly"])

    with pytest.raises(CapabilityInUse) as info:
        svc.delete_skill(a, catalog_id=skill.catalog_id)
    exc = info.value
    assert exc.status == 409 and exc.code == "capability_in_use"
    assert {e.loc[1] for e in exc.errors} == {e1.employee_id, e2.employee_id}  # 跨租户和无关员工都不在其中
    assert "2 位员工" in exc.detail and "周报整理" in exc.detail
    assert catalog.get_skill(a, catalog_id=skill.catalog_id) is not None  # 什么都没动
    assert employees.get(a, employee_id=e1.employee_id).skills == ["weekly", "other"]

    # 选择「只删除，员工配置里保留」
    svc.delete_skill(a, catalog_id=skill.catalog_id, remove_from_employees=False)
    assert catalog.get_skill(a, catalog_id=skill.catalog_id) is None
    kept = employees.get(a, employee_id=e1.employee_id)
    assert kept.skills == ["weekly", "other"] and kept.version == e1.version
    assert audit.events[-1][2:5] == ("skill.deleted_kept_in_employees", "skill", "weekly")
    assert employees.get(b, employee_id=other_tenant.employee_id).skills == ["weekly"]
    assert employees.get(a, employee_id=e3.employee_id).skills == ["other"]


def test_delete_and_remove_from_employees_is_atomic_and_tenant_scoped(env):
    router, svc, audit, employees, catalog, (ta, tb) = env
    a, b = _ctx(ta), _ctx(tb)
    skill = _skill(catalog, a)
    _skill(catalog, b)
    e1 = _employee(employees, a, "e1", skills=["weekly", "other"])
    e2 = _employee(employees, a, "e2", skills=["weekly@1"])
    e3 = _employee(employees, a, "e3", skills=["other"])
    other_tenant = _employee(employees, b, "t-b", skills=["weekly"])

    svc.delete_skill(a, catalog_id=skill.catalog_id, remove_from_employees=True)

    assert catalog.get_skill(a, catalog_id=skill.catalog_id) is None
    got1, got2, got3 = (employees.get(a, employee_id=e.employee_id) for e in (e1, e2, e3))
    assert got1.skills == ["other"] and got2.skills == []
    assert got1.version == e1.version + 1 and got2.version == e2.version + 1  # 下次同步员工拿到新清单
    assert got3.skills == ["other"] and got3.version == e3.version
    assert employees.get(b, employee_id=other_tenant.employee_id).skills == ["weekly"]  # 别的租户的同名技能不受影响
    tenant, actor, action, kind, key, detail = audit.events[-1]
    assert (tenant, actor, action, kind, key) == (ta, "admin-1", "skill.deleted_removed_from_employees", "skill", "weekly")
    assert e1.employee_id in detail and e2.employee_id in detail and e3.employee_id not in detail


def test_unused_skill_deletes_without_a_choice_and_without_audit(env):
    router, svc, audit, employees, catalog, (ta, tb) = env
    a = _ctx(ta)
    skill = _skill(catalog, a)
    _employee(employees, a, "e3", skills=["other"])
    svc.delete_skill(a, catalog_id=skill.catalog_id)
    assert catalog.get_skill(a, catalog_id=skill.catalog_id) is None and audit.events == []


def test_disabling_a_used_skill_asks_first_then_can_remove_or_keep(env):
    router, svc, audit, employees, catalog, (ta, tb) = env
    a = _ctx(ta)
    skill = _skill(catalog, a)
    e1 = _employee(employees, a, "e1", skills=["weekly"])
    disable = SkillCatalogIn(skill_id="weekly", binding_policy="disabled")
    with pytest.raises(CapabilityInUse):
        svc.update_skill(a, disable, catalog_id=skill.catalog_id)
    assert catalog.get_skill(a, catalog_id=skill.catalog_id).binding_policy == "opt_in"
    # 保留：停用后员工清单还在（读取时标为已停用）
    svc.update_skill(a, disable, catalog_id=skill.catalog_id, remove_from_employees=False)
    assert catalog.get_skill(a, catalog_id=skill.catalog_id).binding_policy == "disabled"
    assert employees.get(a, employee_id=e1.employee_id).skills == ["weekly"]
    # 已经停用后再改别的不再追问
    svc.update_skill(a, SkillCatalogIn(skill_id="weekly", binding_policy="disabled", display_name="改名"), catalog_id=skill.catalog_id)
    # 另一项：选择去掉
    skill2 = _skill(catalog, a, "second")
    e2 = _employee(employees, a, "e2", skills=["second", "weekly"])
    svc.update_skill(a, SkillCatalogIn(skill_id="second", binding_policy="disabled"), catalog_id=skill2.catalog_id, remove_from_employees=True)
    assert employees.get(a, employee_id=e2.employee_id).skills == ["weekly"]
    assert audit.events[-1][2] == "skill.disabled_removed_from_employees"


def test_connectors_follow_the_same_rules(env):
    router, svc, audit, employees, catalog, (ta, tb) = env
    a = _ctx(ta)
    connector = catalog.create_connector(a, connector_id="search", display_name="网页搜索", visibility="tenant", grant_scope="tenant_wide", config={})
    e1 = _employee(employees, a, "e1", connectors=["search", "dingtalk"])
    with pytest.raises(CapabilityInUse):
        svc.delete_connector(a, catalog_id=connector.catalog_id)
    svc.delete_connector(a, catalog_id=connector.catalog_id, remove_from_employees=True)
    assert catalog.get_connector(a, catalog_id=connector.catalog_id) is None
    assert employees.get(a, employee_id=e1.employee_id).connector_refs == ["dingtalk"]
    assert audit.events[-1][2] == "connector.deleted_removed_from_employees"


def test_disable_and_remove_rolls_back_together_when_the_unlink_fails(env, monkeypatch):
    """停用 + 去掉引用在同一个事务里：去引用失败时，目录项不能已经被停用（否则管理员没有重试入口）。"""
    router, svc, audit, employees, catalog, (ta, tb) = env
    a = _ctx(ta)
    skill = _skill(catalog, a)
    e1 = _employee(employees, a, "e1", skills=["weekly"])

    def boom(self, ctx, kind, key):
        raise RuntimeError("unlink failed")

    monkeypatch.setattr(EmployeeCapabilityRefRepository, "unlink", boom)
    with pytest.raises(RuntimeError):
        svc.update_skill(a, SkillCatalogIn(skill_id="weekly", binding_policy="disabled"),
                         catalog_id=skill.catalog_id, remove_from_employees=True)
    assert catalog.get_skill(a, catalog_id=skill.catalog_id).binding_policy == "opt_in"
    assert employees.get(a, employee_id=e1.employee_id).skills == ["weekly"]
    assert audit.events == []
    monkeypatch.undo()
    # 重试仍会弹「二选一」，并且能成功
    with pytest.raises(CapabilityInUse):
        svc.update_skill(a, SkillCatalogIn(skill_id="weekly", binding_policy="disabled"), catalog_id=skill.catalog_id)
    svc.update_skill(a, SkillCatalogIn(skill_id="weekly", binding_policy="disabled"),
                     catalog_id=skill.catalog_id, remove_from_employees=True)
    assert employees.get(a, employee_id=e1.employee_id).skills == []
