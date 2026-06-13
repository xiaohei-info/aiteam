"""Layer3 Gateway reconcile/recovery tests."""

import json

import pytest

from agent_gateway.reconcile import (
    catch_up_events,
    check_run_terminal_state,
    reconcile_interrupted_run,
    reconcile_interrupted_runs,
    reconcile_stale_run,
)
from team_panel.domain.entities import RuntimeBinding, RunEvent, TeamRun
from team_panel.transactions.uow import UnitOfWork


@pytest.fixture(scope="session", autouse=True)
def test_server():
    yield None


@pytest.fixture
def uow(db_conn):
    return UnitOfWork(db_conn)


def _insert_team_run(db_conn, run_id: str, status: str = "running") -> TeamRun:
    run = TeamRun(
        id=run_id,
        enterprise_id="ent_test",
        conversation_id="conv_test",
        trigger_type="private_message",
        execution_mode="single_agent",
        status=status,
        entry_employee_id="emp_test",
        idempotency_key=f"idem_{run_id}",
        input_message_json="{}",
    )
    with UnitOfWork(db_conn) as uow:
        uow.team_runs().create(run)
    return run


def _insert_runtime_binding(db_conn, run_id: str, cursor: int = 0) -> RuntimeBinding:
    binding = RuntimeBinding(
        id=f"bind_{run_id}",
        enterprise_id="ent_test",
        owner_type="team_run",
        owner_id=run_id,
        profile_name="emp-test",
        runtime_kind="session",
        runtime_session_id="sess_test",
        sync_status="pending",
        event_cursor=cursor,
    )
    with UnitOfWork(db_conn) as uow:
        uow.runtime_bindings().create(binding)
    return binding


def _insert_run_event(db_conn, event: RunEvent) -> None:
    with UnitOfWork(db_conn) as uow:
        uow.run_events().create(event)


def test_catch_up_events_from_cursor(db_conn, uow, seeded_enterprise):
    run_id = "run_reconcile"
    _insert_team_run(db_conn, run_id)
    _insert_runtime_binding(db_conn, run_id, cursor=2)
    _insert_run_event(
        db_conn,
        RunEvent(
            id="evt_existing",
            enterprise_id="ent_test",
            run_id=run_id,
            cursor_no=2,
            event_type="message_delta",
            source_type="session",
            source_id="sess_test",
            preview_text="existing",
            payload_json=json.dumps({"delta": "old"}),
        ),
    )

    runtime_events = [
        {
            "event_id": "evt_old",
            "event_cursor": 1,
            "event_type": "run_started",
            "source_type": "session",
            "source_id": "sess_test",
            "preview": "old",
            "payload": {},
        },
        {
            "event_id": "evt_dup",
            "event_cursor": 2,
            "event_type": "message_delta",
            "source_type": "session",
            "source_id": "sess_test",
            "preview": "dup",
            "payload": {},
        },
        {
            "event_id": "evt_new_3",
            "event_cursor": 3,
            "event_type": "message_delta",
            "source_type": "session",
            "source_id": "sess_test",
            "preview": "delta-3",
            "payload": {"delta": "new-3"},
            "employee_id": "emp_test",
        },
        {
            "event_id": "evt_new_4",
            "event_cursor": 4,
            "event_type": "run_succeeded",
            "source_type": "session",
            "source_id": "sess_test",
            "preview": "done",
            "payload": {"message_id": "msg_4"},
        },
    ]

    with uow as tx:
        new_cursor = catch_up_events(tx, run_id, runtime_events)

    assert new_cursor == 4

    with UnitOfWork(db_conn) as verify:
        binding = verify.runtime_bindings().get_by_owner("team_run", run_id)
        events = verify.run_events().list_by_run(run_id, after_cursor=0, limit=10)

    assert binding is not None
    assert binding.event_cursor == 4
    assert binding.sync_status == "synced"
    assert [event.cursor_no for event in events] == [2, 3, 4]
    assert [event.id for event in events] == ["evt_existing", "evt_new_3", "evt_new_4"]
    assert json.loads(events[-1].payload_json) == {"message_id": "msg_4"}

    with UnitOfWork(db_conn) as verify_again:
        same_cursor = catch_up_events(verify_again, run_id, runtime_events)
    assert same_cursor == 4

    with UnitOfWork(db_conn) as final_verify:
        assert len(final_verify.run_events().list_by_run(run_id, after_cursor=0, limit=10)) == 3
        final_binding = final_verify.runtime_bindings().get_by_owner("team_run", run_id)
    assert final_binding is not None
    assert final_binding.event_cursor == 4


def test_reconcile_stale_run(db_conn, uow, seeded_enterprise):
    run_id = "run_stale_terminal"
    _insert_team_run(db_conn, run_id, status="running")
    _insert_runtime_binding(db_conn, run_id, cursor=1)
    _insert_run_event(
        db_conn,
        RunEvent(
            id="evt_terminal",
            enterprise_id="ent_test",
            run_id=run_id,
            cursor_no=2,
            event_type="run_failed",
            source_type="session",
            source_id="sess_test",
            preview_text="failed",
            payload_json=json.dumps({"reason": "boom"}),
        ),
    )

    with uow as tx:
        terminal_state = check_run_terminal_state(tx, run_id)
        reconciled_status = reconcile_stale_run(tx, run_id)

    assert terminal_state == "run_failed"
    assert reconciled_status == "failed"

    with UnitOfWork(db_conn) as verify:
        run = verify.team_runs().get_by_id(run_id)
    assert run is not None
    assert run.status == "failed"

    with UnitOfWork(db_conn) as repeat_tx:
        repeated_status = reconcile_stale_run(repeat_tx, run_id)
    assert repeated_status == "failed"


def test_check_run_terminal_state_returns_none_for_non_terminal(db_conn, uow, seeded_enterprise):
    run_id = "run_non_terminal"
    _insert_team_run(db_conn, run_id, status="running")
    _insert_runtime_binding(db_conn, run_id, cursor=1)
    _insert_run_event(
        db_conn,
        RunEvent(
            id="evt_non_terminal",
            enterprise_id="ent_test",
            run_id=run_id,
            cursor_no=2,
            event_type="message_delta",
            source_type="session",
            source_id="sess_test",
            preview_text="still streaming",
            payload_json=json.dumps({"delta": "hi"}),
        ),
    )

    with uow as tx:
        assert check_run_terminal_state(tx, run_id) is None
        assert reconcile_stale_run(tx, run_id) is None


def test_reconcile_interrupted_run_marks_running_run_failed(db_conn, uow, seeded_enterprise):
    run_id = "run_interrupted_worker"
    _insert_team_run(db_conn, run_id, status="running")
    _insert_runtime_binding(db_conn, run_id, cursor=1)
    _insert_run_event(
        db_conn,
        RunEvent(
            id="evt_interrupted_started",
            enterprise_id="ent_test",
            run_id=run_id,
            cursor_no=1,
            event_type="run_started",
            source_type="session",
            source_id="sess_test",
            preview_text="员工开始处理任务",
            payload_json=json.dumps({"profile_name": "emp-test"}),
        ),
    )

    with uow as tx:
        status = reconcile_interrupted_run(tx, run_id, reason="worker disappeared")

    assert status == "failed"

    with UnitOfWork(db_conn) as verify:
        run = verify.team_runs().get_by_id(run_id)
        events = verify.run_events().list_by_run(run_id, after_cursor=0, limit=10)
        binding = verify.runtime_bindings().get_by_owner("team_run", run_id)

    assert run is not None
    assert run.status == "failed"
    assert run.error_code == "INTERRUPTED"
    assert run.error_message == "worker disappeared"
    assert [event.event_type for event in events] == ["run_started", "run_failed"]
    assert events[-1].cursor_no == 2
    assert events[-1].preview_text == "worker disappeared"
    assert binding is not None
    assert binding.event_cursor == 2


def test_reconcile_interrupted_runs_only_marks_runs_before_startup_cutoff(
    db_conn,
    uow,
    seeded_enterprise,
):
    stale_run_id = "run_interrupted_before_startup"
    current_run_id = "run_started_after_startup"
    _insert_team_run(db_conn, stale_run_id, status="running")
    _insert_team_run(db_conn, current_run_id, status="running")
    _insert_runtime_binding(db_conn, stale_run_id, cursor=1)
    _insert_runtime_binding(db_conn, current_run_id, cursor=1)
    _insert_run_event(
        db_conn,
        RunEvent(
            id="evt_interrupted_before_startup_started",
            enterprise_id="ent_test",
            run_id=stale_run_id,
            cursor_no=1,
            event_type="run_started",
            source_type="session",
            source_id="sess_test",
            preview_text="员工开始处理任务",
            payload_json=json.dumps({"profile_name": "emp-test"}),
        ),
    )
    _insert_run_event(
        db_conn,
        RunEvent(
            id="evt_started_after_startup_started",
            enterprise_id="ent_test",
            run_id=current_run_id,
            cursor_no=1,
            event_type="run_started",
            source_type="session",
            source_id="sess_test",
            preview_text="员工开始处理任务",
            payload_json=json.dumps({"profile_name": "emp-test"}),
        ),
    )
    cutoff = "2026-06-13T12:00:00+00:00"
    with db_conn.cursor() as cur:
        cur.execute(
            "UPDATE team_run SET updated_at='2026-06-13T11:59:00+00:00' WHERE id=%s",
            (stale_run_id,),
        )
        cur.execute(
            "UPDATE team_run SET updated_at='2026-06-13T12:01:00+00:00' WHERE id=%s",
            (current_run_id,),
        )
    db_conn.commit()

    with uow as tx:
        recovered_run_ids = reconcile_interrupted_runs(
            tx,
            interrupted_before=cutoff,
            reason="startup recovery",
        )

    assert recovered_run_ids == [stale_run_id]

    with UnitOfWork(db_conn) as verify:
        stale_run = verify.team_runs().get_by_id(stale_run_id)
        current_run = verify.team_runs().get_by_id(current_run_id)
        stale_events = verify.run_events().list_by_run(stale_run_id, after_cursor=0, limit=10)
        current_events = verify.run_events().list_by_run(current_run_id, after_cursor=0, limit=10)

    assert stale_run is not None
    assert stale_run.status == "failed"
    assert stale_run.error_code == "INTERRUPTED"
    assert current_run is not None
    assert current_run.status == "running"
    assert [event.event_type for event in stale_events] == ["run_started", "run_failed"]
    assert [event.event_type for event in current_events] == ["run_started"]
