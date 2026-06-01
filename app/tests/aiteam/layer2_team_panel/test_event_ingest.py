"""L2-S05 event ingest & read-side refresh tests.

Covers T01-T05 from the L2 plan:
  T01 - ingest non-terminal event → runtime_binding cursor advances
  T02 - terminal run_succeeded → team_run mirror + conversation read-side
  T03 - terminal run_failed → team_run mirror with error info
  T04 - duplicate ingest is idempotent
  T05 - reconcile_scheduler no-op seam
"""

import json
import uuid

import pytest

pytestmark = pytest.mark.usefixtures("clean_tables")

from team_panel.domain.entities import (
    Conversation,
    Enterprise,
    RunEvent,
    RuntimeBinding,
    TeamRun,
)
from team_panel.integration.event_ingest_service import ingest_timeline_event
from team_panel.integration.reconcile_scheduler import schedule_reconcile
from team_panel.transactions.uow import UnitOfWork


# ── helpers ───────────────────────────────────────────────────────────

def _uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _make_enterprise(db_conn):
    cur = db_conn.cursor()
    eid = _uid("ent")
    cur.execute(
        "INSERT INTO enterprise (id, slug, name, owner_user_id) "
        "VALUES (%s,%s,%s,%s)",
        (eid, eid, "Test Enterprise", "usr_001"),
    )
    cur.close()
    return eid


def _make_conversation(db_conn, enterprise_id):
    cur = db_conn.cursor()
    cid = _uid("conv")
    cur.execute(
        "INSERT INTO conversation (id, enterprise_id, type, status, created_by) "
        "VALUES (%s,%s,%s,%s,%s)",
        (cid, enterprise_id, "private", "active", "usr_001"),
    )
    cur.close()
    return cid


def _make_run(db_conn, enterprise_id, conversation_id):
    cur = db_conn.cursor()
    rid = _uid("run")
    cur.execute(
        "INSERT INTO team_run (id, enterprise_id, conversation_id, "
        "trigger_type, execution_mode, status) "
        "VALUES (%s,%s,%s,%s,%s,%s)",
        (rid, enterprise_id, conversation_id, "private_message",
         "single_agent", "running"),
    )
    cur.close()
    return rid


def _make_binding(db_conn, enterprise_id, run_id):
    """Create a runtime_binding for a team_run owner."""
    cur = db_conn.cursor()
    bid = _uid("bind")
    cur.execute(
        "INSERT INTO runtime_binding (id, enterprise_id, owner_type, "
        "owner_id, profile_name, runtime_kind, sync_status, event_cursor) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
        (bid, enterprise_id, "team_run", run_id, "ent-test-profile",
         "session", "pending", 0),
    )
    cur.close()
    return bid


def _make_event_payload(event_type, **overrides):
    defaults = {
        "enterprise_id": "",
        "run_id": "",
        "cursor_no": 1,
        "event_type": event_type,
        "source_type": "session",
        "source_id": "sess_001",
    }
    defaults.update(overrides)
    return defaults


# ── display-state helper ──────────────────────────────────────────────

def compute_display_state(conversation_status: str,
                          latest_run_status: str | None) -> str:
    """Derive display state from conversation status + latest run status."""
    if conversation_status == "active":
        if latest_run_status in ("succeeded", "failed", "cancelled"):
            return "resolved"
        return "idle"
    return "idle"


# ═══════════════════════════════════════════════════════════════════════
# T01: test_ingest_event_updates_runtime_binding_cursor
# ═══════════════════════════════════════════════════════════════════════

def test_ingest_event_updates_runtime_binding_cursor(db_conn):
    """After ingesting a non-terminal timeline event:
    - run_event is persisted
    - runtime_binding.event_cursor advances
    - runtime_binding.runtime_source_cursor is updated when present
    - runtime_binding.sync_status becomes synced
    """
    ent_id = _make_enterprise(db_conn)
    conv_id = _make_conversation(db_conn, ent_id)
    run_id = _make_run(db_conn, ent_id, conv_id)
    _make_binding(db_conn, ent_id, run_id)

    event = _make_event_payload("message_delta",
                                enterprise_id=ent_id,
                                run_id=run_id,
                                cursor_no=5,
                                preview_text="Hello from runtime",
                                runtime_source_cursor="src_cursor_99")

    with UnitOfWork(db_conn) as uow:
        result = ingest_timeline_event(uow, event)

    assert result["ingested"] is True
    assert result["terminal"] is False
    assert result["cursor"] == 5

    # Verify RunEvent persisted
    with UnitOfWork(db_conn) as uow:
        events = uow.run_events().list_by_run(run_id)
        assert len(events) == 1
        evt = events[0]
        assert evt.cursor_no == 5
        assert evt.event_type == "message_delta"
        assert evt.preview_text == "Hello from runtime"

    # Verify RuntimeBinding cursor advanced
    with UnitOfWork(db_conn) as uow:
        binding = uow.runtime_bindings().get_by_owner("team_run", run_id)
        assert binding is not None
        assert binding.event_cursor == 5
        assert binding.runtime_source_cursor == "src_cursor_99"
        assert binding.sync_status == "synced"


def test_ingest_event_without_source_cursor_does_not_clear_existing(db_conn):
    """When event has no runtime_source_cursor, the existing value is preserved."""
    ent_id = _make_enterprise(db_conn)
    conv_id = _make_conversation(db_conn, ent_id)
    run_id = _make_run(db_conn, ent_id, conv_id)

    # Pre-set runtime_source_cursor on the binding
    cur = db_conn.cursor()
    bid = _uid("bind")
    cur.execute(
        "INSERT INTO runtime_binding (id, enterprise_id, owner_type, "
        "owner_id, profile_name, runtime_kind, sync_status, event_cursor, "
        "runtime_source_cursor) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (bid, ent_id, "team_run", run_id, "ent-test-profile",
         "session", "pending", 0, "existing_src_cursor"),
    )
    cur.close()

    event = _make_event_payload("message_delta",
                                enterprise_id=ent_id,
                                run_id=run_id,
                                cursor_no=3,
                                preview_text="ok")
    # No runtime_source_cursor in event

    with UnitOfWork(db_conn) as uow:
        ingest_timeline_event(uow, event)

    with UnitOfWork(db_conn) as uow:
        binding = uow.runtime_bindings().get_by_owner("team_run", run_id)
        assert binding.runtime_source_cursor == "existing_src_cursor"


# ═══════════════════════════════════════════════════════════════════════
# T02: test_run_succeeded_updates_conversation_display_state
# ═══════════════════════════════════════════════════════════════════════

def test_run_succeeded_updates_conversation_display_state(db_conn):
    """After ingesting run_succeeded terminal event:
    - team_run.status → succeeded
    - team_run.result_summary_json reflects preview
    - conversation.latest_run_id updated
    - conversation.last_message_preview updated
    - conversation.status NOT changed to 'resolved'
    - compute_display_state returns 'resolved'
    """
    ent_id = _make_enterprise(db_conn)
    conv_id = _make_conversation(db_conn, ent_id)
    run_id = _make_run(db_conn, ent_id, conv_id)
    _make_binding(db_conn, ent_id, run_id)

    event = _make_event_payload("run_succeeded",
                                enterprise_id=ent_id,
                                run_id=run_id,
                                cursor_no=10,
                                preview_text="Task completed successfully.")

    with UnitOfWork(db_conn) as uow:
        result = ingest_timeline_event(uow, event)

    assert result["terminal"] is True

    # Verify TeamRun
    with UnitOfWork(db_conn) as uow:
        run = uow.team_runs().get_by_id(run_id)
        assert run is not None
        assert run.status == "succeeded"
        summary = json.loads(run.result_summary_json or "{}")
        assert "summary" in summary or "Task completed" in str(summary)

    # Verify Conversation read-side
    with UnitOfWork(db_conn) as uow:
        conv = uow.conversations().get_by_id(conv_id)
        assert conv is not None
        assert conv.latest_run_id == run_id
        assert conv.last_message_preview == "Task completed successfully."
        # Status stays active — NOT resolved
        assert conv.status == "active"

    # Verify display state derivation
    assert compute_display_state("active", "succeeded") == "resolved"


def test_run_succeeded_with_payload_result_summary(db_conn):
    """When preview_text is absent, payload is used for result summary."""
    ent_id = _make_enterprise(db_conn)
    conv_id = _make_conversation(db_conn, ent_id)
    run_id = _make_run(db_conn, ent_id, conv_id)
    _make_binding(db_conn, ent_id, run_id)

    event = _make_event_payload("run_succeeded",
                                enterprise_id=ent_id,
                                run_id=run_id,
                                cursor_no=10,
                                payload_json={"result": "done", "tokens": 150})

    with UnitOfWork(db_conn) as uow:
        ingest_timeline_event(uow, event)

    with UnitOfWork(db_conn) as uow:
        run = uow.team_runs().get_by_id(run_id)
        summary = json.loads(run.result_summary_json or "{}")
        assert summary.get("result") == "done"


# ═══════════════════════════════════════════════════════════════════════
# T03: terminal failure / cancellation
# ═══════════════════════════════════════════════════════════════════════

def test_run_failed_updates_team_run_with_error(db_conn):
    """After ingesting run_failed: team_run.status → failed, error fields set."""
    ent_id = _make_enterprise(db_conn)
    conv_id = _make_conversation(db_conn, ent_id)
    run_id = _make_run(db_conn, ent_id, conv_id)
    _make_binding(db_conn, ent_id, run_id)

    event = _make_event_payload("run_failed",
                                enterprise_id=ent_id,
                                run_id=run_id,
                                cursor_no=15,
                                error_code="MODEL_ERROR",
                                error_message="Model unavailable",
                                preview_text="Run failed: Model unavailable")

    with UnitOfWork(db_conn) as uow:
        result = ingest_timeline_event(uow, event)

    assert result["terminal"] is True

    with UnitOfWork(db_conn) as uow:
        run = uow.team_runs().get_by_id(run_id)
        assert run.status == "failed"
        assert run.error_code == "MODEL_ERROR"
        assert "Model unavailable" in run.error_message

    # Conversation display state: resolved
    with UnitOfWork(db_conn) as uow:
        conv = uow.conversations().get_by_id(conv_id)
        assert conv.latest_run_id == run_id
        assert conv.status == "active"

    assert compute_display_state("active", "failed") == "resolved"


def test_run_cancelled_updates_team_run(db_conn):
    """After ingesting run_cancelled: team_run.status → cancelled."""
    ent_id = _make_enterprise(db_conn)
    conv_id = _make_conversation(db_conn, ent_id)
    run_id = _make_run(db_conn, ent_id, conv_id)
    _make_binding(db_conn, ent_id, run_id)

    event = _make_event_payload("run_cancelled",
                                enterprise_id=ent_id,
                                run_id=run_id,
                                cursor_no=20,
                                preview_text="Run cancelled by user")

    with UnitOfWork(db_conn) as uow:
        result = ingest_timeline_event(uow, event)

    assert result["terminal"] is True

    with UnitOfWork(db_conn) as uow:
        run = uow.team_runs().get_by_id(run_id)
        assert run.status == "cancelled"

    assert compute_display_state("active", "cancelled") == "resolved"


# ═══════════════════════════════════════════════════════════════════════
# T04: idempotency / duplicate ingest
# ═══════════════════════════════════════════════════════════════════════

def test_duplicate_ingest_is_idempotent(db_conn):
    """Replaying same run_id + cursor_no does not error and cursor does not regress."""
    ent_id = _make_enterprise(db_conn)
    conv_id = _make_conversation(db_conn, ent_id)
    run_id = _make_run(db_conn, ent_id, conv_id)
    _make_binding(db_conn, ent_id, run_id)

    event = _make_event_payload("run_succeeded",
                                enterprise_id=ent_id,
                                run_id=run_id,
                                cursor_no=10,
                                preview_text="First success")

    # First ingest
    with UnitOfWork(db_conn) as uow:
        ingest_timeline_event(uow, event)

    # Second ingest — same event
    with UnitOfWork(db_conn) as uow:
        result = ingest_timeline_event(uow, event)

    # Should not raise; result may report ingested=True (create skips silently)
    assert result is not None

    # Cursor must not regress
    with UnitOfWork(db_conn) as uow:
        binding = uow.runtime_bindings().get_by_owner("team_run", run_id)
        assert binding.event_cursor == 10
        assert binding.sync_status == "synced"

    # Run state should still be terminal (not double-transition error)
    with UnitOfWork(db_conn) as uow:
        run = uow.team_runs().get_by_id(run_id)
        assert run.status == "succeeded"


def test_cursor_does_not_regress_on_out_of_order(db_conn):
    """When a lower cursor arrives after a higher one, event_cursor does not regress."""
    ent_id = _make_enterprise(db_conn)
    conv_id = _make_conversation(db_conn, ent_id)
    run_id = _make_run(db_conn, ent_id, conv_id)
    _make_binding(db_conn, ent_id, run_id)

    event_high = _make_event_payload("message_delta",
                                     enterprise_id=ent_id,
                                     run_id=run_id,
                                     cursor_no=50,
                                     preview_text="later")
    event_low = _make_event_payload("message_delta",
                                    enterprise_id=ent_id,
                                    run_id=run_id,
                                    cursor_no=10,
                                    preview_text="earlier")

    with UnitOfWork(db_conn) as uow:
        ingest_timeline_event(uow, event_high)
    with UnitOfWork(db_conn) as uow:
        ingest_timeline_event(uow, event_low)

    with UnitOfWork(db_conn) as uow:
        binding = uow.runtime_bindings().get_by_owner("team_run", run_id)
        assert binding.event_cursor == 50  # stays at the higher value


def test_duplicate_terminal_does_not_error(db_conn):
    """Receiving same terminal event twice does not cause an error."""
    ent_id = _make_enterprise(db_conn)
    conv_id = _make_conversation(db_conn, ent_id)
    run_id = _make_run(db_conn, ent_id, conv_id)
    _make_binding(db_conn, ent_id, run_id)

    event = _make_event_payload("run_failed",
                                enterprise_id=ent_id,
                                run_id=run_id,
                                cursor_no=30,
                                preview_text="fail")

    with UnitOfWork(db_conn) as uow:
        ingest_timeline_event(uow, event)
    # No exception on second ingest
    with UnitOfWork(db_conn) as uow:
        ingest_timeline_event(uow, event)

    with UnitOfWork(db_conn) as uow:
        run = uow.team_runs().get_by_id(run_id)
        assert run.status == "failed"


# ═══════════════════════════════════════════════════════════════════════
# T05: reconcile_scheduler no-op
# ═══════════════════════════════════════════════════════════════════════

def test_schedule_reconcile_returns_noop_result(db_conn):
    """reconcile_scheduler.schedule_reconcile is callable and returns predictable dict."""
    ent_id = _make_enterprise(db_conn)
    conv_id = _make_conversation(db_conn, ent_id)
    run_id = _make_run(db_conn, ent_id, conv_id)

    with UnitOfWork(db_conn) as uow:
        result = schedule_reconcile(uow, run_id, 42)

    assert result == {
        "scheduled": False,
        "run_id": run_id,
        "reason": "noop-v1",
    }


# ═══════════════════════════════════════════════════════════════════════
# Edge cases
# ═══════════════════════════════════════════════════════════════════════

def test_ingest_missing_required_fields_raises(db_conn):
    """Missing enterprise_id/run_id/event_type raises ValueError."""
    ent_id = _make_enterprise(db_conn)
    conv_id = _make_conversation(db_conn, ent_id)
    run_id = _make_run(db_conn, ent_id, conv_id)

    with UnitOfWork(db_conn) as uow:
        with pytest.raises(ValueError):
            ingest_timeline_event(uow, {"cursor_no": 1})


def test_ingest_events_incrementally(db_conn):
    """Multiple events ingested in order advance cursor correctly."""
    ent_id = _make_enterprise(db_conn)
    conv_id = _make_conversation(db_conn, ent_id)
    run_id = _make_run(db_conn, ent_id, conv_id)
    _make_binding(db_conn, ent_id, run_id)

    for cursor_no in range(1, 6):
        event = _make_event_payload("message_delta",
                                    enterprise_id=ent_id,
                                    run_id=run_id,
                                    cursor_no=cursor_no)
        with UnitOfWork(db_conn) as uow:
            ingest_timeline_event(uow, event)

    with UnitOfWork(db_conn) as uow:
        events = uow.run_events().list_by_run(run_id)
        assert len(events) == 5
        binding = uow.runtime_bindings().get_by_owner("team_run", run_id)
        assert binding.event_cursor == 5
        assert binding.sync_status == "synced"
