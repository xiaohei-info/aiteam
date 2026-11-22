"""员工技能 / 连接器引用的统一入口（设计 2026-11-22 §3.2、§3.5）：状态、新增校验、快照指纹不受影响。

非 integration：用内存伪目录，不依赖 PG。
"""

from types import SimpleNamespace

import pytest

from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict

from manager_service.capability_catalog_repository import SkillCatalogSummaryRow
from manager_service.employee_capability_refs import EmployeeCapabilityRefs, EmployeeCapabilityUnavailable, ref_key
from manager_service.employee_config_service import EmployeeConfigService
from manager_service.schemas import EmployeeConfigIn

from tests.manager.test_employee_config import _FakeRepo, _ctx


def _skill(skill_id, *, name="", version="1", policy="opt_in", shaped=True, content_hash="h"):
    return SkillCatalogSummaryRow(
        skill_id=skill_id, display_name=name or skill_id, version=version, binding_policy=policy,
        visibility="tenant", config={}, content_hash=content_hash, package_shaped=shaped,
    )


class _FakeCatalog:
    def __init__(self, skills=(), connectors=()):
        self._skills, self._connectors = list(skills), list(connectors)

    def list_skill_summaries(self, ctx):
        return self._skills

    def list_connectors(self, ctx):
        return self._connectors


def _connector(connector_id, grant_scope="tenant_wide", name=""):
    return SimpleNamespace(connector_id=connector_id, display_name=name or connector_id, grant_scope=grant_scope)


CATALOG = _FakeCatalog(
    skills=[
        _skill("weekly", name="周报整理", version="1.2"),
        _skill("ppt", name="汇报 PPT 大纲", shaped=False, content_hash=""),
        _skill("broken", name="简历解析", shaped=False, content_hash="x"),
        _skill("old", name="合同审阅", policy="disabled"),
    ],
    connectors=[_connector("search", name="网页搜索"), _connector("dingtalk", "disabled", "钉钉表格")],
)


def _refs():
    return EmployeeCapabilityRefs(CATALOG)


def test_ref_key_ignores_pinned_version():
    assert ref_key("weekly@1.2") == "weekly" and ref_key("weekly") == "weekly"


def test_every_state_has_a_plain_reason():
    skills, connectors = _refs().statuses(
        _ctx("t"), ["weekly", "ppt", "broken", "old", "gone"], ["search", "dingtalk", "gone"],
    )
    assert [(s.ref, s.status) for s in skills] == [
        ("weekly", "ready"), ("ppt", "draft"), ("broken", "invalid"), ("old", "disabled"), ("gone", "missing"),
    ]
    assert skills[0].reason is None and skills[0].display_name == "周报整理"
    assert skills[1].reason == "还没完成，暂时不能给员工用"
    assert skills[4].display_name == "gone" and "已从企业技能库移除" in skills[4].reason
    assert [(c.ref, c.status) for c in connectors] == [("search", "ready"), ("dingtalk", "disabled"), ("gone", "missing")]
    # 面向管理员的文案不出现技术词
    for item in [*skills, *connectors]:
        assert "skill_id" not in (item.reason or "") and "绑定" not in (item.reason or "")


def test_pinned_version_that_the_catalog_no_longer_has_is_missing():
    # authorized_config_service 对版本不一致的引用同样不下发
    (item,), _ = _refs().statuses(_ctx("t"), ["weekly@0.9"], [])
    assert item.status == "missing"
    (item,), _ = _refs().statuses(_ctx("t"), ["weekly@1.2"], [])
    assert item.status == "ready"


def test_save_rejects_new_unavailable_items_with_per_item_reasons():
    with pytest.raises(EmployeeCapabilityUnavailable) as info:
        _refs().validate_additions(
            _ctx("t"), before_skills=[], after_skills=["weekly", "ppt", "old", "gone"],
            before_connectors=[], after_connectors=["dingtalk"],
        )
    exc = info.value
    assert isinstance(exc, Conflict) and exc.status == 409 and exc.code == "employee_capability_unavailable"
    assert {(tuple(e.loc), e.type) for e in exc.errors} == {
        (("body", "skills", "ppt"), "draft"), (("body", "skills", "old"), "disabled"),
        (("body", "skills", "gone"), "missing"), (("body", "connector_refs", "dingtalk"), "disabled"),
    }
    assert any("「汇报 PPT 大纲」还没完成" in e.message for e in exc.errors)


def test_existing_dangling_items_never_block_saving():
    _refs().validate_additions(
        _ctx("t"), before_skills=["gone", "old@1", "ppt"], after_skills=["gone", "old", "ppt", "weekly"],
        before_connectors=["dingtalk"], after_connectors=["dingtalk", "search"],
    )


def test_service_validates_on_create_and_update_but_only_additions():
    repo = _FakeRepo()
    svc = EmployeeConfigService(repo, capability_refs=_refs())
    ctx = _ctx("t-a")
    with pytest.raises(EmployeeCapabilityUnavailable):
        svc.create(ctx, EmployeeConfigIn(display_name="x", skills=["ppt"]), employee_slug="e1")
    created = svc.create(ctx, EmployeeConfigIn(display_name="x", skills=["weekly"]), employee_slug="e1")
    with pytest.raises(EmployeeCapabilityUnavailable):
        svc.update(ctx, EmployeeConfigIn(display_name="x", skills=["weekly", "gone"]), employee_id=created.employee_id)
    # 员工之后被删了技能：存量悬空项照样能保存别的修改
    repo._bucket(ctx)[created.employee_id].skills.append("gone")
    ok = svc.update(ctx, EmployeeConfigIn(display_name="改名", skills=["weekly", "gone"]), employee_id=created.employee_id)
    assert ok.display_name == "改名"


def test_status_is_opt_in_so_snapshots_and_fingerprints_stay_clean():
    repo = _FakeRepo()
    svc = EmployeeConfigService(repo, capability_refs=_refs())
    ctx = _ctx("t-a")
    created = svc.create(ctx, EmployeeConfigIn(display_name="x", skills=["weekly"]), employee_slug="e1")
    assert created.skill_status == [] and created.connector_status == []
    plain = svc.get(ctx, employee_id=created.employee_id)
    assert plain.skill_status == []
    shown = svc.get(ctx, employee_id=created.employee_id, with_status=True)
    assert [(s.ref, s.status) for s in shown.skill_status] == [("weekly", "ready")]
    assert [e.skill_status for e in svc.list_all(ctx)] == [[]]
    assert [s.status for s in svc.list_all(ctx, with_status=True)[0].skill_status] == ["ready"]
