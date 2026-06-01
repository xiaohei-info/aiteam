"""L3-S02 RuntimeHandle and cursor tests.

T01 — runtime_handle minimal field set (unit test)
T02 — cursor monotonic within run
T03 — cursor never decreases
"""

import uuid

import pytest

pytestmark = pytest.mark.usefixtures("clean_tables")

from agent_gateway.contracts import RuntimeHandle
from agent_gateway.runtime_handle import create_handle, advance_cursor
from team_panel.transactions.uow import UnitOfWork


# ═══════════════════════════════════════════════════════════════════════
# T01 — runtime_handle has minimal fields
# ═══════════════════════════════════════════════════════════════════════

def test_runtime_handle_has_minimal_fields():
    """RuntimeHandle must carry enterprise_id, employee_id, run_id, kind,
    profile_name as required fields; session_id / task_id / job_id default
    to None."""
    handle = RuntimeHandle(
        enterprise_id="ent_001",
        employee_id="emp_001",
        run_id="run_001",
        kind="session",
        profile_name="ent001-test-profile",
    )
    assert handle.enterprise_id == "ent_001"
    assert handle.employee_id == "emp_001"
    assert handle.run_id == "run_001"
    assert handle.kind == "session"
    assert handle.profile_name == "ent001-test-profile"
    assert handle.session_id is None
    assert handle.task_id is None
    assert handle.job_id is None


def test_runtime_handle_all_kinds_valid():
    """All four Gateway-kind values are accepted."""
    for kind in ("session", "kanban_task", "cron_job", "composite"):
        h = RuntimeHandle(
            enterprise_id="ent_001",
            employee_id="emp_001",
            run_id="run_x",
            kind=kind,
            profile_name="p",
        )
        assert h.kind == kind


# ═══════════════════════════════════════════════════════════════════════
# T02 — cursor monotonic within run
# ═══════════════════════════════════════════════════════════════════════

def _seed_enterprise(cur, ent_id="ent_t02"):
    cur.execute(
        "INSERT INTO enterprise (id, slug, name, owner_user_id) "
        "VALUES (%s, %s, %s, %s)",
        (ent_id, ent_id, "Test Enterprise", "usr_001"),
    )
    return ent_id


def _seed_run(cur, ent_id, run_id="run_t02"):
    cur.execute(
        "INSERT INTO team_run (id, enterprise_id, trigger_type, execution_mode, status) "
        "VALUES (%s, %s, %s, %s, %s)",
        (run_id, ent_id, "private_message", "single_agent", "running"),
    )
    return run_id


def test_cursor_monotonic_within_run(db_conn):
    """advance_cursor advances the event cursor for a run binding."""
    cur = db_conn.cursor()
    try:
        ent_id = _seed_enterprise(cur)
        run_id = _seed_run(cur, ent_id)
    finally:
        cur.close()
    db_conn.commit()

    # Arrange — create handle via the production function
    with UnitOfWork(db_conn) as uow:
        handle = create_handle(
            uow,
            enterprise_id=ent_id,
            employee_id="emp_t02",
            run_id=run_id,
            kind="session",
            profile_name="ent-test-profile",
        )

    assert handle.run_id == run_id
    assert handle.session_id is not None

    # Advance cursor: 0 → 5 → 10
    with UnitOfWork(db_conn) as uow:
        advance_cursor(uow, run_id, 5)

    with UnitOfWork(db_conn) as uow:
        advance_cursor(uow, run_id, 10)

    # Verify final state
    with UnitOfWork(db_conn) as uow:
        binding = uow.runtime_bindings().get_by_owner("team_run", run_id)
        assert binding is not None
        assert binding.event_cursor == 10
        assert binding.sync_status == "synced"


# ═══════════════════════════════════════════════════════════════════════
# T03 — cursor never decreases
# ═══════════════════════════════════════════════════════════════════════

def test_cursor_never_decreases(db_conn):
    """advance_cursor raises ValueError for non-increasing cursor."""
    cur = db_conn.cursor()
    try:
        ent_id = _seed_enterprise(cur, "ent_t03")
        run_id = _seed_run(cur, ent_id, "run_t03")
    finally:
        cur.close()
    db_conn.commit()

    # Arrange — binding at cursor 10
    with UnitOfWork(db_conn) as uow:
        create_handle(
            uow,
            enterprise_id=ent_id,
            employee_id="emp_t03",
            run_id=run_id,
            kind="session",
            profile_name="ent-test-profile",
        )
        advance_cursor(uow, run_id, 10)

    # Attempt to go backwards → ValueError
    with pytest.raises(ValueError, match="Cursor must advance"):
        with UnitOfWork(db_conn) as uow:
            advance_cursor(uow, run_id, 5)

    # Attempt to set equal cursor → ValueError
    with pytest.raises(ValueError, match="Cursor must advance"):
        with UnitOfWork(db_conn) as uow:
            advance_cursor(uow, run_id, 10)

    # Forward is still allowed
    with UnitOfWork(db_conn) as uow:
        advance_cursor(uow, run_id, 15)

    with UnitOfWork(db_conn) as uow:
        binding = uow.runtime_bindings().get_by_owner("team_run", run_id)
        assert binding.event_cursor == 15
