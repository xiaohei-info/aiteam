"""Layer 2 view service tests — workbench, conversation, billing views.

Verifies:
- T01: WorkbenchView stable required fields
- T02: Conversation display_state computed from status + latest_run + latest_event
- T03: Billing view aggregates tokens and cost

DB-dependent tests seed their own data inline to be robust against
conftest changes from concurrent work.
"""

import uuid
from datetime import date

import pytest
from team_panel.domain.entities import (
    Conversation,
    Employee,
    RunEvent,
    TeamRun,
)
from team_panel.domain.enums import EmployeeStatus
from team_panel.transactions.uow import UnitOfWork
from team_panel.application.queries.conversation_view_service import (
    get_conversation_view,
    list_conversation_views,
)
from team_panel.views.assemblers import (
    _aggregate_run_cost_cents,
    _aggregate_run_tokens,
    _parse_cost_cents_from_json,
    _parse_tokens_from_json,
    assemble_billing_view,
)
from team_panel.views.schemas import (
    BillingView,
    ConversationView,
    WorkbenchView,
    compute_display_state,
)


def _eid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _seed_enterprise(db_conn, ent_id: str) -> str:
    """Seed one enterprise and return its id."""
    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO enterprise (id, slug, name, status, owner_user_id) "
            "VALUES (%s, %s, %s, %s, %s)",
            (ent_id, f"slug-{ent_id[:8]}", "Test Corp", "active", "user_001"),
        )
        db_conn.commit()
    finally:
        cur.close()
    return ent_id


def _seed_employee(db_conn, emp_id: str, ent_id: str, status: str = "active") -> str:
    """Seed one employee and return its id."""
    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO employee (id, enterprise_id, profile_name, display_name, "
            "role_name, status, created_from, model_provider, model_name, "
            "prompt_version, config_version, capabilities_json) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (emp_id, ent_id, f"profile-{emp_id[:8]}", f"Name-{emp_id[:6]}",
             "assistant", status, "talent_market",
             "openai", "gpt-4o", 1, 1, '{}'),
        )
        db_conn.commit()
    finally:
        cur.close()
    return emp_id


# ── T01: Workbench stable required fields ──────────────────────────────────

class TestWorkbenchView:
    """T01: WorkbenchView returns stable required fields."""

    def test_workbench_view_has_required_fields(self, db_conn):
        ent_id = _eid("ent")
        _seed_enterprise(db_conn, ent_id)

        with UnitOfWork(db_conn) as uow:
            for i in range(3):
                uow.employees().create(Employee(
                    id=_eid(f"emp{i}"), enterprise_id=ent_id,
                    profile_name=f"p-{_eid('p')}{i}", display_name=f"Emp {i}",
                    status=EmployeeStatus.ACTIVE,
                ))
            for i in range(2):
                uow.conversations().create(Conversation(
                    id=_eid(f"conv{i}"), enterprise_id=ent_id,
                    type="private", status="active",
                    title=f"Chat {i}", created_by="user_1",
                ))

        with UnitOfWork(db_conn) as uow:
            from team_panel.application.queries.workbench_view_service import get_workbench_view
            view = get_workbench_view(uow, ent_id)

        assert isinstance(view, WorkbenchView)
        assert view.enterprise_id == ent_id
        assert view.active_employees == 3
        assert view.active_conversations == 2
        assert view.today_runs >= 0
        assert view.today_tokens >= 0
        assert isinstance(view.recent_conversations, list)

    def test_workbench_view_counts_active_employees(self, db_conn):
        ent_id = _eid("ent")
        _seed_enterprise(db_conn, ent_id)

        with UnitOfWork(db_conn) as uow:
            uow.employees().create(Employee(
                id=_eid("ea"), enterprise_id=ent_id,
                profile_name=f"p-active-{_eid('x')}", display_name="Active A",
                status=EmployeeStatus.ACTIVE,
            ))
            uow.employees().create(Employee(
                id=_eid("ep"), enterprise_id=ent_id,
                profile_name=f"p-paused-{_eid('x')}", display_name="Paused P",
                status=EmployeeStatus.PAUSED,
            ))

        with UnitOfWork(db_conn) as uow:
            from team_panel.application.queries.workbench_view_service import get_workbench_view
            view = get_workbench_view(uow, ent_id)

        assert view.active_employees == 1  # only the active one
        assert view.active_conversations == 0


# ── T02: Conversation display_state computed ───────────────────────────────

class TestConversationDisplayState:
    """T02: Conversation display_state is computed from status + latest run + latest event."""

    def test_display_state_idle_when_not_active(self):
        assert compute_display_state("draft", None) == "idle"
        assert compute_display_state("archived", None) == "idle"
        assert compute_display_state("paused", "running") == "idle"

    def test_display_state_idle_when_no_run(self):
        assert compute_display_state("active", None) == "idle"

    def test_display_state_routing(self):
        assert compute_display_state("active", "routing") == "routing"
        assert compute_display_state("active", "submitting") == "routing"
        assert compute_display_state("active", "queued") == "idle"

    def test_display_state_streaming_when_running_with_delta(self):
        assert compute_display_state("active", "running", has_recent_delta=True) == "streaming"

    def test_display_state_busy_when_running_without_delta(self):
        assert compute_display_state("active", "running", has_recent_delta=False) == "busy"

    def test_display_state_waiting_reply(self):
        assert compute_display_state("active", "waiting_human") == "waiting_reply"

    def test_display_state_resolved(self):
        assert compute_display_state("active", "succeeded") == "resolved"
        assert compute_display_state("active", "failed") == "resolved"
        assert compute_display_state("active", "cancelled") == "resolved"

    def test_display_state_not_persisted_to_db(self, db_conn):
        """Display state must be computed, never persisted into conversation.status."""
        ent_id = _eid("ent")
        cid = _eid("conv")
        rid = _eid("run")
        _seed_enterprise(db_conn, ent_id)

        with UnitOfWork(db_conn) as uow:
            uow.conversations().create(Conversation(
                id=cid, enterprise_id=ent_id,
                type="private", status="active",
                title="Test", created_by="user_1",
            ))
            uow.team_runs().create(TeamRun(
                id=rid, enterprise_id=ent_id,
                conversation_id=cid,
                trigger_type="private_message",
                execution_mode="single_agent",
                status="running",
            ))

        with UnitOfWork(db_conn) as uow:
            conv = uow.conversations().get_by_id(cid)
            assert conv is not None
            assert conv.status == "active"  # NOT "streaming" or any display state
            assert compute_display_state("active", "running") == "busy"

    def test_assemble_conversation_view_stable_schema(self, db_conn):
        ent_id = _eid("ent")
        cid = _eid("conv")
        rid = _eid("run")
        _seed_enterprise(db_conn, ent_id)

        with UnitOfWork(db_conn) as uow:
            uow.conversations().create(Conversation(
                id=cid, enterprise_id=ent_id,
                type="private", status="active",
                title="Test Conversation",
                latest_run_id=rid,
                last_message_preview="Hello world",
                created_by="user_1",
            ))
            uow.team_runs().create(TeamRun(
                id=rid, enterprise_id=ent_id,
                conversation_id=cid,
                trigger_type="private_message",
                execution_mode="single_agent",
                status="running",
            ))
            uow.run_events().create(RunEvent(
                id=_eid("ev"), enterprise_id=ent_id,
                run_id=rid, cursor_no=1,
                event_type="message_delta",
                source_type="session", source_id="src_1",
                preview_text="thinking...",
            ))

        with UnitOfWork(db_conn) as uow:
            view = get_conversation_view(uow, cid)

        assert view is not None
        assert isinstance(view, ConversationView)
        assert view.id == cid
        assert view.conv_type == "private"
        assert view.status == "active"
        assert view.display_state == "streaming"  # running + message_delta
        assert view.title == "Test Conversation"
        assert view.last_preview == "Hello world"
        assert view.member_count == 0
        assert isinstance(view.updated_at, str)

    def test_list_conversation_views_uses_latest_run_and_latest_event_per_conversation(self, db_conn):
        ent_id = _eid("ent")
        _seed_enterprise(db_conn, ent_id)

        conv_a = _eid("conv")
        run_a = _eid("run")
        conv_b = _eid("conv")
        run_b = _eid("run")

        with UnitOfWork(db_conn) as uow:
            uow.conversations().create(Conversation(
                id=conv_a, enterprise_id=ent_id,
                type="private", status="active",
                title="Conversation A", latest_run_id=run_a,
                last_message_preview="A preview", created_by="user_1",
            ))
            uow.conversations().create(Conversation(
                id=conv_b, enterprise_id=ent_id,
                type="private", status="active",
                title="Conversation B", latest_run_id=run_b,
                last_message_preview="B preview", created_by="user_1",
            ))
            uow.team_runs().create(TeamRun(
                id=run_a, enterprise_id=ent_id, conversation_id=conv_a,
                trigger_type="private_message", execution_mode="single_agent",
                status="running",
            ))
            uow.team_runs().create(TeamRun(
                id=run_b, enterprise_id=ent_id, conversation_id=conv_b,
                trigger_type="private_message", execution_mode="single_agent",
                status="succeeded",
            ))
            uow.run_events().create(RunEvent(
                id=_eid("ev"), enterprise_id=ent_id, run_id=run_a, cursor_no=1,
                event_type="message_delta", source_type="session", source_id="src_1",
            ))
            uow.run_events().create(RunEvent(
                id=_eid("ev"), enterprise_id=ent_id, run_id=run_b, cursor_no=1,
                event_type="run_succeeded", source_type="session", source_id="src_2",
            ))

        with UnitOfWork(db_conn) as uow:
            views = list_conversation_views(uow, ent_id)

        by_id = {view.id: view for view in views}
        assert by_id[conv_a].display_state == "streaming"
        assert by_id[conv_b].display_state == "resolved"


# ── T03: Billing aggregates tokens and cost ────────────────────────────────

class TestBillingView:
    """T03: Billing view aggregates tokens and cost."""

    def test_parse_tokens_from_json(self):
        assert _parse_tokens_from_json(None) == 0
        assert _parse_tokens_from_json("") == 0
        assert _parse_tokens_from_json("invalid") == 0
        assert _parse_tokens_from_json('{"tokens": 150}') == 150
        assert _parse_tokens_from_json('{"total_tokens": 300}') == 300
        assert _parse_tokens_from_json('{"usage": {"total_tokens": 500}}') == 500
        assert _parse_tokens_from_json('{"usage": {"tokens": 100}}') == 100
        # Also test with Python dict (psycopg2 JSONB → dict)
        assert _parse_tokens_from_json({"tokens": 42}) == 42

    def test_parse_cost_from_json(self):
        assert _parse_cost_cents_from_json(None) == 0
        assert _parse_cost_cents_from_json('{"cost_cents": 1250}') == 1250
        assert _parse_cost_cents_from_json('{"cost": 500}') == 500
        assert _parse_cost_cents_from_json('{"usage": {"cost_cents": 3000}}') == 3000

    def test_aggregate_run_tokens_and_cost(self):
        run = TeamRun(
            id="r1", enterprise_id="ent",
            trigger_type="private_message",
            execution_mode="single_agent",
            result_summary_json='{"tokens": 100, "cost_cents": 50}',
        )
        events = [
            RunEvent(
                id="ev1", enterprise_id="ent", run_id="r1", cursor_no=1,
                event_type="usage_recorded", source_type="session", source_id="s1",
                payload_json='{"tokens": 200, "cost": 80}',
            ),
            RunEvent(
                id="ev2", enterprise_id="ent", run_id="r1", cursor_no=2,
                event_type="message_delta", source_type="session", source_id="s1",
                payload_json='{}',
            ),
        ]
        assert _aggregate_run_tokens(run, events) == 300  # 100 + 200
        assert _aggregate_run_cost_cents(run, events) == 130  # 50 + 80

    def test_assemble_billing_view_empty(self):
        view = assemble_billing_view("ent", "2026-01-01", "2026-01-02", [])
        assert isinstance(view, BillingView)
        assert view.total_tokens == 0
        assert view.total_cost_cents == 0
        assert view.by_employee == []

    def test_assemble_billing_view_with_runs(self):
        runs = [
            TeamRun(
                id="r1", enterprise_id="ent",
                entry_employee_id="emp_a",
                trigger_type="private_message",
                execution_mode="single_agent",
                result_summary_json='{"tokens": 100, "cost_cents": 10}',
            ),
            TeamRun(
                id="r2", enterprise_id="ent",
                entry_employee_id="emp_b",
                trigger_type="private_message",
                execution_mode="single_agent",
                result_summary_json='{"tokens": 200, "cost_cents": 20}',
            ),
        ]
        view = assemble_billing_view("ent", "2026-01-01", "2026-01-02", runs)
        assert view.total_tokens == 300
        assert view.total_cost_cents == 30
        assert len(view.by_employee) == 2

        emp_a = next(e for e in view.by_employee if e.employee_id == "emp_a")
        assert emp_a.tokens == 100
        assert emp_a.cost_cents == 10

    def test_billing_view_service_from_db(self, db_conn):
        """Integration test: billing_view_service reads runs from DB."""
        ent_id = _eid("ent")
        emp_id = _eid("emp")
        _seed_enterprise(db_conn, ent_id)
        _seed_employee(db_conn, emp_id, ent_id, status="active")

        with UnitOfWork(db_conn) as uow:
            uow.team_runs().create(TeamRun(
                id=_eid("r"), enterprise_id=ent_id,
                entry_employee_id=emp_id,
                trigger_type="private_message",
                execution_mode="single_agent",
                status="succeeded",
                result_summary_json='{"tokens": 500, "cost_cents": 250}',
            ))

        with UnitOfWork(db_conn) as uow:
            from team_panel.application.queries.billing_view_service import get_billing_view
            view = get_billing_view(uow, ent_id,
                                     period_start="2000-01-01",
                                     period_end="2099-12-31")

        assert view.total_tokens == 500
        assert view.total_cost_cents == 250
        assert len(view.by_employee) == 1
        assert view.by_employee[0].employee_id == emp_id
