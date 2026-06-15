"""System planner domain/policy tests."""

import json

from team_panel.application.commands.conversation_service import ensure_system_planner
from team_panel.application.policies.route_decision_service import decide_route
from team_panel.domain.entities import Employee
from team_panel.domain.enums import CreatedFrom, EmployeeStatus
from team_panel.repositories.employee_repo import EmployeeRepo


class FakeCursor:
    def __init__(self, row=None):
        self.row = row
        self.calls = []

    def execute(self, sql, params):
        self.calls.append((sql, params))

    def fetchone(self):
        return self.row


def test_employee_repo_get_system_planner_queries_capabilities_flag():
    row = (
        "emp_planner", "ent_12345678", None, "sys_planner_ent_1234", "协作主持人",
        "orchestrator", "active", "admin_seed", "", "", 1, 1, None, None,
        None, None, {"is_system_planner": True}, "", "", "", "", None,
    )
    cur = FakeCursor(row)
    planner = EmployeeRepo(cur).get_system_planner("ent_12345678")

    sql, params = cur.calls[0]
    assert "capabilities_json @>" in sql
    assert "deleted_at IS NULL" in sql
    assert params == ("ent_12345678",)
    assert planner.id == "emp_planner"
    assert "is_system_planner" in planner.capabilities_json


class FakeEmployeeRepo:
    def __init__(self):
        self.planner = None
        self.created = []

    def get_system_planner(self, enterprise_id):
        return self.planner

    def create(self, employee):
        self.created.append(employee)
        self.planner = employee
        return employee


class FakeUow:
    def __init__(self):
        self.employee_repo = FakeEmployeeRepo()

    def employees(self):
        return self.employee_repo


def test_ensure_system_planner_creates_active_admin_seed_once():
    uow = FakeUow()

    first = ensure_system_planner(uow, "ent_1234567890")
    second = ensure_system_planner(uow, "ent_1234567890")

    assert first is second
    assert len(uow.employee_repo.created) == 1
    assert first.enterprise_id == "ent_1234567890"
    assert first.profile_name == "sys_planner_ent_1234"
    assert first.display_name == "协作主持人"
    assert first.role_name == "orchestrator"
    assert first.created_from == CreatedFrom.ADMIN_SEED
    assert first.status == EmployeeStatus.ACTIVE
    assert json.loads(first.capabilities_json) == {"is_system_planner": True}


def test_decide_route_defaults_to_orchestration_for_non_planner_members():
    decision = decide_route(
        "请处理这个需求",
        [
            {"employee_id": "emp_a", "display_name": "A", "role_name": "分析师", "profile_name": "a"},
            {"employee_id": "emp_b", "display_name": "B", "role_name": "研究员", "profile_name": "b"},
            {"employee_id": "emp_sys", "display_name": "协作主持人", "role_name": "orchestrator", "profile_name": "sys_planner_ent", "is_system_planner": True},
        ],
        route_hint="auto",
    )

    assert decision.route_mode == "orchestration"
    assert decision.target_employee_ids == ("emp_a", "emp_b")
    assert decision.planner_employee_id == "emp_sys"


def test_decide_route_only_system_planner_degrades_to_single_agent():
    decision = decide_route(
        "请处理这个需求",
        [
            {"employee_id": "emp_sys", "display_name": "协作主持人", "role_name": "orchestrator", "profile_name": "sys_planner_ent", "is_system_planner": True},
        ],
        route_hint="auto",
    )

    assert decision.route_mode == "single_agent"
    assert decision.target_employee_ids == ()


def test_decide_route_does_not_treat_business_orchestrator_role_as_system_planner():
    decision = decide_route(
        "请处理这个需求",
        [
            {"employee_id": "emp_a", "display_name": "A", "role_name": "orchestrator", "profile_name": "a", "is_system_planner": False},
            {"employee_id": "emp_b", "display_name": "B", "role_name": "研究员", "profile_name": "b", "is_system_planner": False},
            {"employee_id": "emp_sys", "display_name": "协作主持人", "role_name": "orchestrator", "profile_name": "sys_planner_ent", "is_system_planner": True},
        ],
        route_hint="auto",
    )

    assert decision.route_mode == "orchestration"
    assert decision.target_employee_ids == ("emp_a", "emp_b")
    assert decision.planner_employee_id == "emp_sys"
