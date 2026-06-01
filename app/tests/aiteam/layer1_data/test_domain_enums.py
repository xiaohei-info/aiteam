"""L1-S01 domain enums and value objects tests.

Covers T01, T03, and value-object immutability/semantics per the L1 plan.
"""
import pytest
from team_panel.domain.enums import (
    EmployeeStatus,
    ConversationType,
    ExecutionMode,
    TriggerType,
    CreatedFrom,
)
from team_panel.domain.value_objects import (
    RuntimeHandleRef,
    CredentialRef,
    Money,
    RouteDecision,
)


# ── T01: EmployeeStatus values ───────────────────────────────────────────

_EMPLOYEE_STATUS_VALUES = {
    "draft",
    "provisioning",
    "active",
    "paused",
    "provisioning_failed",
    "archived",
}


def test_employee_status_values_match_spec():
    """EmployeeStatus must contain exactly the 6 fixed values per §5.1."""
    values = set(e.value for e in EmployeeStatus)
    assert values == _EMPLOYEE_STATUS_VALUES, (
        f"Expected {_EMPLOYEE_STATUS_VALUES}, got {values}"
    )


# ── T03: Remaining enum value coverage ───────────────────────────────────

_CONVERSATION_TYPE_VALUES = {"private", "group"}


def test_conversation_type_values_match_spec():
    values = set(e.value for e in ConversationType)
    assert values == _CONVERSATION_TYPE_VALUES


_EXECUTION_MODE_VALUES = {"single_agent", "kanban_orchestration", "cron_single_agent"}


def test_execution_mode_values_match_spec():
    values = set(e.value for e in ExecutionMode)
    assert values == _EXECUTION_MODE_VALUES


_TRIGGER_TYPE_VALUES = {
    "private_message",
    "group_message",
    "manual_run",
    "scheduled_job",
    "api_call",
}


def test_trigger_type_values_match_spec():
    values = set(e.value for e in TriggerType)
    assert values == _TRIGGER_TYPE_VALUES


_CREATED_FROM_VALUES = {
    "talent_market",
    "manual",
    "solution_apply",
    "admin_seed",
}


def test_created_from_values_match_spec():
    values = set(e.value for e in CreatedFrom)
    assert values == _CREATED_FROM_VALUES


# ── Value object: RuntimeHandleRef ────────────────────────────────────────

def test_runtime_handle_ref_immutable():
    ref = RuntimeHandleRef(
        enterprise_id="ent_001",
        employee_id="emp_001",
        run_id="run_001",
        kind="session",
        profile_name="test-profile",
    )
    with pytest.raises(AttributeError):
        ref.enterprise_id = "changed"  # type: ignore[misc]


def test_runtime_handle_ref_optional_fields_default_none():
    ref = RuntimeHandleRef(
        enterprise_id="ent_001",
        employee_id="emp_001",
        run_id="run_001",
        kind="kanban_task",
        profile_name="test-profile",
    )
    assert ref.session_id is None
    assert ref.task_id is None
    assert ref.job_id is None


# ── Value object: CredentialRef ───────────────────────────────────────────

def test_credential_ref_immutable():
    cred = CredentialRef(credential_id="cred_abc", provider="openai", scope="rw")
    with pytest.raises(AttributeError):
        cred.provider = "anthropic"  # type: ignore[misc]


def test_credential_ref_default_scope():
    cred = CredentialRef(credential_id="cred_abc", provider="openai")
    assert cred.scope == ""


# ── Value object: Money ──────────────────────────────────────────────────

def test_money_add_same_currency():
    m1 = Money(amount_cents=100, currency="CNY")
    m2 = Money(amount_cents=250, currency="CNY")
    result = m1 + m2
    assert result.amount_cents == 350
    assert result.currency == "CNY"


def test_money_add_currency_mismatch_raises():
    m1 = Money(amount_cents=100, currency="CNY")
    m2 = Money(amount_cents=100, currency="USD")
    with pytest.raises(ValueError, match="Currency mismatch"):
        _ = m1 + m2


def test_money_immutable():
    m = Money(amount_cents=100, currency="CNY")
    with pytest.raises(AttributeError):
        m.amount_cents = 200  # type: ignore[misc]


def test_money_default_currency():
    m = Money(amount_cents=0)
    assert m.currency == "CNY"


# ── Value object: RouteDecision ──────────────────────────────────────────

def test_route_decision_immutable():
    rd = RouteDecision(
        route_mode="auto",
        target_employee_ids=("emp_a", "emp_b"),
        planner_employee_id="emp_planner",
    )
    with pytest.raises(AttributeError):
        rd.route_mode = "single_agent"  # type: ignore[misc]


def test_route_decision_defaults():
    rd = RouteDecision(route_mode="single_agent")
    assert rd.target_employee_ids == ()
    assert rd.planner_employee_id == ""
