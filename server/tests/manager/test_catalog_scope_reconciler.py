"""R3 发布范围对账：停用 / 自动恢复 / 手动暂停不被替管理员启用 / 幂等 / 目录故障放弃。"""

from dataclasses import replace

import pytest

from manager_service.catalog_scope_reconciler import (
    REVOKED,
    REVOKED_KEEP_PAUSED,
    ScopeReconciler,
    TemplateOutOfScopeConflict,
    is_scope_blocked,
)
from manager_service.employee_config_repository import EmployeeConfigRow
from manager_service.operator_catalog import FakeOperatorCatalogClient
from shared.contracts.crosstier import ExpertTemplateDetail
from shared.contracts.tenancy import TenantContext
from shared.errors import AppError

CTX = TenantContext(tenant_id="t-1", user_id="worker", roles=[])


def _row(emp, template, status="active", reason=None, name=None):
    return EmployeeConfigRow(
        employee_id=emp, employee_slug=emp, display_name=name or emp, persona=None, model=None,
        provider_ref=None, thinking_level=None, timeout_seconds=None, tools=[], skills=[],
        knowledge_refs=[], connector_refs=[], memory_policy=None, version=1, status=status,
        source_template_id=template, status_reason=reason,
    )


class FakeEmployees:
    def __init__(self, rows):
        self.rows = {r.employee_id: r for r in rows}

    def list_all(self, ctx):
        return list(self.rows.values())

    def set_scope_state(self, ctx, *, employee_id, expect_status, expect_reason, new_status, new_reason):
        row = self.rows[employee_id]
        if row.status != expect_status or row.status_reason != expect_reason:
            return False
        self.rows[employee_id] = replace(row, status=new_status, status_reason=new_reason)
        return True


class Notifier:
    def __init__(self):
        self.sent = []

    def deliver_internal(self, ctx, *, message, notify_type, severity):
        self.sent.append((message, notify_type, severity))


@pytest.fixture
def catalog():
    fake = FakeOperatorCatalogClient()
    for tid in ("tpl-a", "tpl-b"):
        fake.seed_expert(ExpertTemplateDetail(template_id=tid, version="1", display_name=tid))
    return fake


def _run(catalog, rows, **kw):
    employees, notifier = FakeEmployees(rows), Notifier()
    result = ScopeReconciler(catalog, employees, notifier).reconcile(CTX, **kw)
    return result, employees, notifier


def test_visible_templates_change_nothing(catalog):
    result, employees, notifier = _run(catalog, [_row("e1", "tpl-a")])
    assert not result.changed and employees.rows["e1"].status == "active" and notifier.sent == []


def test_narrowed_scope_pauses_active_employee_and_notifies_once(catalog):
    catalog.hide_from("t-1", "tpl-a")
    rows = [_row("e1", "tpl-a", name="客服"), _row("e2", "tpl-b")]
    result, employees, notifier = _run(catalog, rows)
    assert result.disabled == ["客服"]
    assert (employees.rows["e1"].status, employees.rows["e1"].status_reason) == ("paused", REVOKED)
    assert employees.rows["e2"].status == "active"
    assert len(notifier.sent) == 1 and "客服" in notifier.sent[0][0]

    # 再对账一次：已停用，幂等，不再通知
    again = ScopeReconciler(catalog, employees, notifier).reconcile(CTX)
    assert not again.changed and len(notifier.sent) == 1


def test_manually_paused_employee_is_blocked_but_not_reactivated_later(catalog):
    catalog.hide_from("t-1", "tpl-a")
    result, employees, _ = _run(catalog, [_row("e1", "tpl-a", status="paused")])
    row = employees.rows["e1"]
    assert (row.status, row.status_reason) == ("paused", REVOKED_KEEP_PAUSED) and is_scope_blocked(row)
    assert result.disabled == ["e1"]  # 手动暂停的也被挡住启用，但状态不变

    catalog.show_to("t-1", "tpl-a")
    restored = ScopeReconciler(catalog, employees, Notifier()).reconcile(CTX)
    row = employees.rows["e1"]
    assert (row.status, row.status_reason) == ("paused", None) and restored.restored == []


def test_restored_scope_reactivates_only_auto_paused(catalog):
    catalog.hide_from("t-1", "tpl-a")
    _, employees, notifier = _run(catalog, [_row("e1", "tpl-a", name="客服")])
    catalog.show_to("t-1", "tpl-a")
    result = ScopeReconciler(catalog, employees, notifier).reconcile(CTX)
    assert result.restored == ["客服"]
    assert (employees.rows["e1"].status, employees.rows["e1"].status_reason) == ("active", None)
    assert len(notifier.sent) == 2  # 停用一条、恢复一条


def test_unpublished_template_is_not_a_scope_problem(catalog):
    rows = [_row("e1", "tpl-gone")]  # 目录里没有：下架 / 不存在，不动员工
    result, employees, _ = _run(catalog, rows)
    assert not result.changed and employees.rows["e1"].status == "active"


def test_copies_and_archived_are_ignored(catalog):
    catalog.hide_from("t-1", "tpl-a")
    rows = [_row("copy", None), _row("old", "tpl-a", status="archived")]
    result, employees, _ = _run(catalog, rows)
    assert not result.changed and employees.rows["copy"].status == "active"


def test_catalog_failure_aborts_without_touching_employees(catalog):
    def boom(**kw):
        raise AppError("operator down")

    catalog.list_expert_templates = boom
    result, employees, _ = _run(catalog, [_row("e1", "tpl-a")])
    assert not result.changed and employees.rows["e1"].status == "active"


def test_template_filter_only_checks_that_template(catalog):
    catalog.hide_from("t-1", "tpl-a")
    catalog.hide_from("t-1", "tpl-b")
    _, employees, _ = _run(catalog, [_row("e1", "tpl-a"), _row("e2", "tpl-b")], template_id="tpl-a")
    assert employees.rows["e1"].status == "paused" and employees.rows["e2"].status == "active"


def test_scope_conflict_has_stable_code():
    assert TemplateOutOfScopeConflict("x").code == "template_out_of_scope"
    assert TemplateOutOfScopeConflict("x").status == 409
