"""技能 / 连接器被员工使用时的删除、停用联动——不依赖 PG 的单测（真 PG 用例见 test_capability_in_use_pg.py）。"""

import pytest

from manager_service.capability_catalog_service import CapabilityCatalogService, CapabilityInUse
from manager_service.employee_capability_ref_repository import (
    DeleteOutcome, EmployeeCapabilityRefRepository, EmployeeUse, ref_key,
)
from manager_service.schemas import ConnectorCatalogIn, SkillCatalogIn
from shared.errors import NotFound

from tests.manager._fake_router import FakeCursor, FakeRouter, ctx as make_ctx
from tests.manager.test_capability_catalog import _FakeRepo

CTX = make_ctx()


class _Audit:
    def __init__(self):
        self.events = []

    def record(self, ctx, *, actor, action, resource_type=None, resource_id=None, detail=None):
        self.events.append((action, resource_type, resource_id, detail))


class _Refs:
    """内存版员工引用：和真实仓库同样的三个入口。"""

    def __init__(self, repo, employees):
        self.repo, self.employees = repo, employees  # employees: {id: {"name", "skills", "connectors"}}

    def transaction(self, ctx):
        from contextlib import contextmanager

        @contextmanager
        def scope():
            yield self.repo, self
        return scope()

    def _column(self, kind):
        return "skills" if kind == "skill" else "connectors"

    def employees_using(self, ctx, kind, key):
        return [EmployeeUse(i, e["name"]) for i, e in self.employees.items()
                if any(ref_key(kind, r) == key for r in e[self._column(kind)])]

    def delete_catalog_entry(self, ctx, kind, catalog_id, *, unlink):
        getter = self.repo.get_skill if kind == "skill" else self.repo.get_connector
        row = getter(ctx, catalog_id=catalog_id)
        if row is None:
            return None
        key = row.skill_id if kind == "skill" else row.connector_id
        uses = self.employees_using(ctx, kind, key)
        if uses and unlink is None:
            return DeleteOutcome(deleted=False, uses=uses)
        if uses and unlink:
            self.unlink(ctx, kind, key)
        self.repo.delete(ctx, resource_kind=kind, catalog_id=catalog_id)
        return DeleteOutcome(deleted=True, uses=uses)

    def unlink(self, ctx, kind, key):
        uses = self.employees_using(ctx, kind, key)
        col = self._column(kind)
        for use in uses:
            self.employees[use.employee_id][col] = [r for r in self.employees[use.employee_id][col] if ref_key(kind, r) != key]
        return uses


def _setup():
    repo, audit = _FakeRepo(), _Audit()
    employees = {
        "e1": {"name": "招聘专员", "skills": ["weekly", "other"], "connectors": ["search"]},
        "e2": {"name": "", "skills": ["weekly@1"], "connectors": []},
    }
    svc = CapabilityCatalogService(repo, _Refs(repo, employees), audit)
    skill = svc.create_skill(CTX, SkillCatalogIn(skill_id="weekly", display_name="周报"))
    connector = svc.create_connector(CTX, ConnectorCatalogIn(connector_id="search", display_name="搜索"))
    return svc, repo, audit, employees, skill, connector


def test_ref_key_only_strips_version_for_skills():
    assert ref_key("skill", "weekly@1") == "weekly" and ref_key("connector", "a@b") == "a@b"


def test_delete_skill_without_a_choice_is_refused_and_lists_employees():
    svc, repo, audit, employees, skill, _ = _setup()
    with pytest.raises(CapabilityInUse) as info:
        svc.delete_skill(CTX, catalog_id=skill.catalog_id)
    assert info.value.code == "capability_in_use"
    assert [e.loc[1] for e in info.value.errors] == ["e1", "e2"]
    assert "2 位员工" in info.value.detail and "周报" in info.value.detail
    assert repo.get_skill(CTX, catalog_id=skill.catalog_id) is not None and audit.events == []


def test_delete_skill_remove_or_keep_and_audit():
    svc, repo, audit, employees, skill, _ = _setup()
    svc.delete_skill(CTX, catalog_id=skill.catalog_id, remove_from_employees=True)
    assert employees["e1"]["skills"] == ["other"] and employees["e2"]["skills"] == []
    assert audit.events[-1][:3] == ("skill.deleted_removed_from_employees", "skill", "weekly")
    assert "e1,e2" in audit.events[-1][3]

    svc, repo, audit, employees, skill, _ = _setup()
    svc.delete_skill(CTX, catalog_id=skill.catalog_id, remove_from_employees=False)
    assert employees["e1"]["skills"] == ["weekly", "other"]
    assert audit.events[-1][0] == "skill.deleted_kept_in_employees"


def test_delete_skill_not_found_and_without_refs_service():
    svc, repo, *_ = _setup()
    with pytest.raises(NotFound):
        svc.delete_skill(CTX, catalog_id="nope")
    plain = CapabilityCatalogService(repo)  # 隔离的领域测试：不联动
    created = plain.create_skill(CTX, SkillCatalogIn(skill_id="solo", display_name="独立"))
    plain.delete_skill(CTX, catalog_id=created.catalog_id)
    with pytest.raises(NotFound):
        plain.delete_skill(CTX, catalog_id=created.catalog_id)
    # 记录不到审计 / 没人在用也不报错
    plain._record(CTX, "x", "skill", "solo", [EmployeeUse("e", "n")])


def test_delete_connector_paths():
    svc, repo, audit, employees, _, connector = _setup()
    with pytest.raises(CapabilityInUse):
        svc.delete_connector(CTX, catalog_id=connector.catalog_id)
    svc.delete_connector(CTX, catalog_id=connector.catalog_id, remove_from_employees=True)
    assert employees["e1"]["connectors"] == []
    assert audit.events[-1][0] == "connector.deleted_removed_from_employees"
    with pytest.raises(NotFound):
        svc.delete_connector(CTX, catalog_id=connector.catalog_id)

    svc, repo, audit, employees, _, connector = _setup()
    svc.delete_connector(CTX, catalog_id=connector.catalog_id, remove_from_employees=False)
    assert employees["e1"]["connectors"] == ["search"]
    assert audit.events[-1][0] == "connector.deleted_kept_in_employees"

    plain = CapabilityCatalogService(repo)
    created = plain.create_connector(CTX, ConnectorCatalogIn(connector_id="solo", display_name="独立"))
    plain.delete_connector(CTX, catalog_id=created.catalog_id)
    with pytest.raises(NotFound):
        plain.delete_connector(CTX, catalog_id=created.catalog_id)


def test_disabling_a_used_skill_asks_first():
    svc, repo, audit, employees, skill, _ = _setup()
    disable = SkillCatalogIn(skill_id="weekly", binding_policy="disabled")
    with pytest.raises(CapabilityInUse):
        svc.update_skill(CTX, disable, catalog_id=skill.catalog_id)
    assert repo.get_skill(CTX, catalog_id=skill.catalog_id).binding_policy != "disabled"
    svc.update_skill(CTX, disable, catalog_id=skill.catalog_id, remove_from_employees=True)
    assert repo.get_skill(CTX, catalog_id=skill.catalog_id).binding_policy == "disabled"
    assert employees["e1"]["skills"] == ["other"]
    assert audit.events[-1][0] == "skill.disabled_removed_from_employees"
    # 已经停用后再改别的不再追问
    svc.update_skill(CTX, SkillCatalogIn(skill_id="weekly", binding_policy="disabled", display_name="改名"), catalog_id=skill.catalog_id)


def test_disabling_a_used_skill_can_keep_employee_config():
    svc, repo, audit, employees, skill, _ = _setup()
    svc.update_skill(CTX, SkillCatalogIn(skill_id="weekly", binding_policy="disabled"),
                     catalog_id=skill.catalog_id, remove_from_employees=False)
    assert employees["e1"]["skills"] == ["weekly", "other"]
    assert audit.events[-1][0] == "skill.disabled_kept_in_employees"


def test_disabling_a_used_connector_asks_first():
    svc, repo, audit, employees, _, connector = _setup()
    disable = ConnectorCatalogIn(connector_id="search", display_name="搜索", grant_scope="disabled")
    with pytest.raises(CapabilityInUse):
        svc.update_connector(CTX, disable, catalog_id=connector.catalog_id)
    svc.update_connector(CTX, disable, catalog_id=connector.catalog_id, remove_from_employees=True)
    assert employees["e1"]["connectors"] == []
    assert audit.events[-1][0] == "connector.disabled_removed_from_employees"

    svc, repo, audit, employees, _, connector = _setup()
    svc.update_connector(CTX, disable, catalog_id=connector.catalog_id, remove_from_employees=False)
    assert employees["e1"]["connectors"] == ["search"]
    assert audit.events[-1][0] == "connector.disabled_kept_in_employees"
    with pytest.raises(NotFound):
        svc.update_connector(CTX, disable, catalog_id="nope")


def test_in_use_message_truncates_long_employee_lists():
    from manager_service.capability_catalog_service import _in_use
    err = _in_use("skill", "周报", [EmployeeUse(f"e{i}", f"员工{i}") for i in range(7)])
    assert err.detail.count("员工") >= 5 and "等）" in err.detail and len(err.errors) == 7


# ---- 仓库层：用假会话走一遍 SQL 分支 ----

def _repo(*cursors):
    router = FakeRouter().queue_many(*cursors)
    return EmployeeCapabilityRefRepository(router), router


def test_repository_employees_using_matches_key_not_prefix():
    repo, _ = _repo(FakeCursor(fetchall=[("e1", "甲", ["weekly@1", "x"]), ("e2", None, ["weekly-report"]), ("e3", "丙", None)]))
    assert repo.employees_using(CTX, "skill", "weekly") == [EmployeeUse("e1", "甲")]


def test_repository_delete_entry_branches():
    row = FakeCursor(fetchone=("weekly",))
    employee_rows = FakeCursor(fetchall=[("e1", "甲", ["weekly", "x"])])
    # 目录项不存在
    repo, _ = _repo(FakeCursor())
    assert repo.delete_catalog_entry(CTX, "skill", "c1", unlink=None) is None
    # 有人在用且没表态：什么都不动
    repo, router = _repo(row, employee_rows)
    outcome = repo.delete_catalog_entry(CTX, "skill", "c1", unlink=None)
    assert outcome.deleted is False and [u.employee_id for u in outcome.uses] == ["e1"]
    assert not any("DELETE" in sql for sql, _ in router.executed)
    # 只删目录项
    repo, router = _repo(row, employee_rows)
    assert repo.delete_catalog_entry(CTX, "skill", "c1", unlink=False).deleted is True
    assert not any("UPDATE employee" in sql for sql, _ in router.executed)
    # 同事务去掉
    repo, router = _repo(row, employee_rows, FakeCursor(fetchone=(["weekly", "x"],)))
    assert repo.delete_catalog_entry(CTX, "skill", "c1", unlink=True).deleted is True
    update = [params for sql, params in router.executed if sql.startswith("UPDATE employee")]
    assert update and update[0][0] == '["x"]'
    assert any(sql.startswith("DELETE FROM skill_catalog") for sql, _ in router.executed)
    # 连接器走另一张表
    repo, router = _repo(FakeCursor(fetchone=("search",)), FakeCursor())
    assert repo.delete_catalog_entry(CTX, "connector", "c2", unlink=None).deleted is True
    assert any("connector_catalog" in sql for sql, _ in router.executed)


def test_repository_unlink():
    repo, router = _repo(FakeCursor(fetchall=[("e1", "甲", ["a"])]), FakeCursor(fetchone=(["a"],)))
    assert [u.employee_id for u in repo.unlink(CTX, "connector", "a")] == ["e1"]
    assert [params for sql, params in router.executed if sql.startswith("UPDATE employee")][0][0] == "[]"
    repo, _ = _repo(FakeCursor())
    assert repo.unlink(CTX, "skill", "none") == []


def test_repository_transaction_binds_both_repositories_to_one_session():
    from manager_service.capability_catalog_repository import CapabilityCatalogRepository
    repo, router = _repo()
    with repo.transaction(CTX) as (catalog, refs):
        assert isinstance(catalog, CapabilityCatalogRepository) and isinstance(refs, EmployeeCapabilityRefRepository)
        assert catalog._router._session is refs._router._session
