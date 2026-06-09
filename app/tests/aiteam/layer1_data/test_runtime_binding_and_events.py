"""L1-S04 ScheduledJob / RuntimeBinding / RunEvent / AuditEvent aggregate tests.

Covers T01-T08 per the L1 plan:
  T01 - scheduled_job status valid values
  T02 - runtime_binding stores owner_type/owner_id + runtime_kind + sync_status
  T03 - run_event cursor monotonic constraint
  T04 - audit_event required fields
  T05 - scheduled_job lifecycle transitions (draft→enabled→paused→error→archived)
  T06 - runtime_binding sync_status transitions
  T07 - migration creates scheduled_job/runtime_binding/run_event/audit_event tables
  T08 - repository persistence for new aggregates
"""

import pytest
import uuid

from team_panel.domain.entities import (
    ScheduledJob,
    RuntimeBinding,
    RunEvent,
    AuditEvent,
)


# ═══════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════

_VALID_SCHEDULED_JOB_STATUSES = {"draft", "enabled", "paused", "error", "archived"}
_VALID_SYNC_STATUSES = {"pending", "synced", "dirty", "failed", "orphaned"}


def _make_scheduled_job(**kw):
    defaults = dict(
        id=f"job_{uuid.uuid4().hex[:8]}",
        enterprise_id="ent_001",
        employee_id="emp_001",
        name="Daily Report",
        schedule_expr="0 9 * * *",
    )
    defaults.update(kw)
    return ScheduledJob(**defaults)


def _make_runtime_binding(**kw):
    defaults = dict(
        id=f"bind_{uuid.uuid4().hex[:8]}",
        enterprise_id="ent_001",
        owner_type="employee",
        owner_id="emp_001",
        profile_name="ent001-test-001",
        runtime_kind="profile",
    )
    defaults.update(kw)
    return RuntimeBinding(**defaults)


def _make_run_event(**kw):
    defaults = dict(
        id=f"evt_{uuid.uuid4().hex[:8]}",
        enterprise_id="ent_001",
        run_id="run_001",
        cursor_no=1,
        event_type="run_created",
        source_type="session",
        source_id="ses_001",
    )
    defaults.update(kw)
    return RunEvent(**defaults)


def _make_audit_event(**kw):
    defaults = dict(
        id=f"audit_{uuid.uuid4().hex[:8]}",
        enterprise_id="ent_001",
        actor_type="user",
        actor_id="usr_001",
        event_type="employee.created",
        target_type="employee",
        target_id="emp_001",
    )
    defaults.update(kw)
    return AuditEvent(**defaults)


# ═══════════════════════════════════════════════════════════════════
# T01: scheduled_job status valid values
# ═══════════════════════════════════════════════════════════════════

def test_scheduled_job_status_valid():
    """scheduled_job status must be one of draft/enabled/paused/error/archived."""
    job = _make_scheduled_job()
    assert job.status == "draft"
    assert job.status in _VALID_SCHEDULED_JOB_STATUSES

    for st in _VALID_SCHEDULED_JOB_STATUSES:
        j = _make_scheduled_job(status=st)
        assert j.status == st
        assert j.status in _VALID_SCHEDULED_JOB_STATUSES


def test_scheduled_job_default_status_is_draft():
    job = _make_scheduled_job()
    assert job.status == "draft"


def test_scheduled_job_default_max_failures_is_3():
    job = _make_scheduled_job()
    assert job.max_consecutive_failures == 3
    assert job.consecutive_failures == 0


# ═══════════════════════════════════════════════════════════════════
# T02: runtime_binding stores owner_type/owner_id + runtime_kind + sync_status
# ═══════════════════════════════════════════════════════════════════

def test_runtime_binding_stores_owner_and_runtime_kind():
    binding = _make_runtime_binding(
        owner_type="scheduled_job",
        owner_id="job_001",
        profile_name="worker-profile",
        runtime_kind="cron_job",
    )
    assert binding.owner_type == "scheduled_job"
    assert binding.owner_id == "job_001"
    assert binding.profile_name == "worker-profile"
    assert binding.runtime_kind == "cron_job"
    assert binding.sync_status == "pending"
    assert binding.event_cursor == 0


def test_runtime_binding_defaults():
    binding = _make_runtime_binding()
    assert binding.owner_type == "employee"
    assert binding.runtime_kind == "profile"
    assert binding.sync_status == "pending"
    assert binding.runtime_session_id is None
    assert binding.runtime_task_id is None
    assert binding.runtime_job_id is None


def test_runtime_binding_runtime_source_cursor_default():
    binding = _make_runtime_binding()
    assert binding.runtime_source_cursor is None


def test_runtime_binding_sync_status_valid():
    binding = _make_runtime_binding()
    assert binding.sync_status in _VALID_SYNC_STATUSES

    for st in _VALID_SYNC_STATUSES:
        b = _make_runtime_binding(sync_status=st)
        assert b.sync_status == st


# ═══════════════════════════════════════════════════════════════════
# T03: run_event cursor monotonic constraint
# ═══════════════════════════════════════════════════════════════════

def test_run_event_cursor_is_numeric():
    evt = _make_run_event(cursor_no=42)
    assert evt.cursor_no == 42
    assert isinstance(evt.cursor_no, int)


def test_run_event_default_fields():
    evt = _make_run_event()
    assert evt.cursor_no == 1
    assert evt.event_type == "run_created"
    assert evt.source_type == "session"
    assert evt.payload_json == "{}"


def test_run_event_has_preview_not_full_payload():
    """run_event stores preview/ids/cursor/summary, not giant raw payloads."""
    evt = _make_run_event(
        preview_text="Agent responded with market analysis",
        payload_json='{"summary": "short", "ids": ["a","b"]}',
    )
    assert evt.preview_text == "Agent responded with market analysis"
    assert "summary" in evt.payload_json


# ═══════════════════════════════════════════════════════════════════
# T04: audit_event required fields
# ═══════════════════════════════════════════════════════════════════

def test_audit_event_required_fields():
    evt = AuditEvent(
        id="audit_001",
        enterprise_id="ent_001",
        actor_type="user",
        actor_id="usr_001",
        event_type="employee.archived",
        target_type="employee",
        target_id="emp_001",
    )
    assert evt.id == "audit_001"
    assert evt.enterprise_id == "ent_001"
    assert evt.actor_type == "user"
    assert evt.actor_id == "usr_001"
    assert evt.event_type == "employee.archived"
    assert evt.target_type == "employee"
    assert evt.target_id == "emp_001"


def test_audit_event_actor_type_valid():
    """actor_type must be user|employee|system|gateway per §6.19."""
    for atype in ("user", "employee", "system", "gateway"):
        evt = _make_audit_event(actor_type=atype)
        assert evt.actor_type == atype


def test_audit_event_defaults():
    evt = _make_audit_event()
    assert evt.payload_json == "{}"
    assert evt.request_id is None


# ═══════════════════════════════════════════════════════════════════
# T05: scheduled_job lifecycle transitions
# ═══════════════════════════════════════════════════════════════════

def test_scheduled_job_lifecycle_draft_to_enabled():
    job = _make_scheduled_job(status="draft")
    job.enable()
    assert job.status == "enabled"


def test_scheduled_job_lifecycle_paused_to_enabled():
    job = _make_scheduled_job(status="paused")
    job.enable()
    assert job.status == "enabled"


def test_scheduled_job_cannot_enable_from_error():
    job = _make_scheduled_job(status="error")
    with pytest.raises(ValueError, match="Cannot enable from error"):
        job.enable()


def test_scheduled_job_cannot_enable_from_archived():
    job = _make_scheduled_job(status="archived")
    with pytest.raises(ValueError, match="Cannot enable from archived"):
        job.enable()


def test_scheduled_job_cannot_enable_with_empty_name():
    job = _make_scheduled_job(status="draft", name="")
    with pytest.raises(ValueError, match="empty name"):
        job.enable()


def test_scheduled_job_pause():
    job = _make_scheduled_job(status="enabled")
    job.pause()
    assert job.status == "paused"


def test_scheduled_job_cannot_pause_from_draft():
    job = _make_scheduled_job(status="draft")
    with pytest.raises(ValueError, match="Cannot pause from draft"):
        job.pause()


def test_scheduled_job_mark_error():
    job = _make_scheduled_job(status="enabled")
    job.mark_error()
    assert job.status == "error"


def test_scheduled_job_clear_error():
    job = _make_scheduled_job(status="error")
    job.clear_error()
    assert job.status == "draft"


def test_scheduled_job_archive():
    job = _make_scheduled_job(status="enabled")
    job.archive()
    assert job.status == "archived"


def test_scheduled_job_cannot_archive_twice():
    job = _make_scheduled_job(status="archived")
    with pytest.raises(ValueError, match="Already archived"):
        job.archive()


def test_scheduled_job_record_failure_increments():
    job = _make_scheduled_job(status="enabled", max_consecutive_failures=5)
    job.record_failure()
    assert job.consecutive_failures == 1
    assert job.status == "enabled"
    job.record_failure()
    assert job.consecutive_failures == 2


def test_scheduled_job_record_failure_triggers_error():
    job = _make_scheduled_job(status="enabled", max_consecutive_failures=2)
    job.record_failure()  # 1
    assert job.status == "enabled"
    job.record_failure()  # 2 → threshold
    assert job.consecutive_failures == 2
    assert job.status == "error"


def test_scheduled_job_record_success_resets():
    job = _make_scheduled_job(status="enabled", consecutive_failures=3)
    job.record_success()
    assert job.consecutive_failures == 0
    assert job.status == "enabled"


def test_scheduled_job_is_terminal():
    active = _make_scheduled_job(status="enabled")
    assert active.is_terminal() is False
    archived = _make_scheduled_job(status="archived")
    assert archived.is_terminal() is True


# ═══════════════════════════════════════════════════════════════════
# T06: runtime_binding sync_status transitions
# ═══════════════════════════════════════════════════════════════════

def test_runtime_binding_mark_synced():
    binding = _make_runtime_binding(sync_status="pending")
    binding.mark_synced()
    assert binding.sync_status == "synced"

    binding2 = _make_runtime_binding(sync_status="dirty")
    binding2.mark_synced()
    assert binding2.sync_status == "synced"


def test_runtime_binding_cannot_sync_from_orphaned():
    binding = _make_runtime_binding(sync_status="orphaned")
    with pytest.raises(ValueError, match="Cannot mark synced from orphaned"):
        binding.mark_synced()


def test_runtime_binding_mark_dirty():
    binding = _make_runtime_binding(sync_status="synced")
    binding.mark_dirty()
    assert binding.sync_status == "dirty"


def test_runtime_binding_cannot_mark_dirty_from_pending():
    binding = _make_runtime_binding(sync_status="pending")
    with pytest.raises(ValueError, match="Cannot mark dirty from pending"):
        binding.mark_dirty()


def test_runtime_binding_cannot_mark_dirty_from_orphaned():
    binding = _make_runtime_binding(sync_status="orphaned")
    with pytest.raises(ValueError, match="Cannot mark dirty from orphaned"):
        binding.mark_dirty()


def test_runtime_binding_mark_failed():
    binding = _make_runtime_binding(sync_status="synced")
    binding.mark_failed("connection timeout")
    assert binding.sync_status == "failed"
    assert binding.last_error == "connection timeout"


def test_runtime_binding_mark_orphaned():
    binding = _make_runtime_binding(sync_status="synced")
    binding.mark_orphaned()
    assert binding.sync_status == "orphaned"


def test_runtime_binding_advance_cursor():
    binding = _make_runtime_binding(event_cursor=5)
    binding.advance_cursor(10)
    assert binding.event_cursor == 10


def test_runtime_binding_cursor_must_be_greater():
    binding = _make_runtime_binding(event_cursor=5)
    with pytest.raises(ValueError, match="Cursor must advance"):
        binding.advance_cursor(3)
    with pytest.raises(ValueError, match="Cursor must advance"):
        binding.advance_cursor(5)


# ═══════════════════════════════════════════════════════════════════
# T07: Migration DDL verification (requires PG)
# ═══════════════════════════════════════════════════════════════════

# -- Migration table existence tests --

def test_migration_creates_scheduled_job_table(db_conn):
    cur = db_conn.cursor()
    cur.execute("SELECT table_name FROM information_schema.tables WHERE table_name = 'scheduled_job'")
    assert cur.fetchone() is not None
    cur.close()


def test_migration_creates_runtime_binding_table(db_conn):
    cur = db_conn.cursor()
    cur.execute("SELECT table_name FROM information_schema.tables WHERE table_name = 'runtime_binding'")
    assert cur.fetchone() is not None
    cur.close()


def test_migration_creates_run_event_table(db_conn):
    cur = db_conn.cursor()
    cur.execute("SELECT table_name FROM information_schema.tables WHERE table_name = 'run_event'")
    assert cur.fetchone() is not None
    cur.close()


def test_migration_creates_audit_event_table(db_conn):
    cur = db_conn.cursor()
    cur.execute("SELECT table_name FROM information_schema.tables WHERE table_name = 'audit_event'")
    assert cur.fetchone() is not None
    cur.close()


def test_migration_runtime_binding_has_runtime_source_cursor_column(db_conn):
    cur = db_conn.cursor()
    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'runtime_binding' AND column_name = 'runtime_source_cursor'")
    assert cur.fetchone() is not None
    cur.close()


# -- Check constraint tests --

def test_scheduled_job_check_constraint_rejects_invalid_status(db_conn):
    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s,%s,%s,%s)",
                ("ent_cs", "ent-cs", "Test", "u1"))
    cur.execute("INSERT INTO employee (id, enterprise_id, profile_name, status) VALUES (%s,%s,%s,%s)",
                ("emp_cs", "ent_cs", "cs-profile", "active"))
    with pytest.raises(Exception):
        cur.execute(
            "INSERT INTO scheduled_job (id, enterprise_id, employee_id, name, schedule_expr, status) "
            "VALUES (%s,%s,%s,%s,%s,%s)",
            ("sj_invalid", "ent_cs", "emp_cs", "Test", "* * * * *", "running"),
        )
    cur.close()


def test_runtime_binding_check_constraint_rejects_invalid_sync_status(db_conn):
    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s,%s,%s,%s)",
                ("ent_rb", "ent-rb", "Test", "u1"))
    with pytest.raises(Exception):
        cur.execute(
            "INSERT INTO runtime_binding (id, enterprise_id, owner_type, owner_id, profile_name, runtime_kind, sync_status) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s)",
            ("rb_invalid", "ent_rb", "employee", "emp_001", "prof", "profile", "unknown"),
        )
    cur.close()


def test_runtime_binding_unique_owner_constraint(db_conn):
    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s,%s,%s,%s)",
                ("ent_rb2", "ent-rb2", "Test", "u1"))
    cur.execute(
        "INSERT INTO runtime_binding (id, enterprise_id, owner_type, owner_id, profile_name, runtime_kind, sync_status) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s)",
        ("rb_001", "ent_rb2", "employee", "emp_001", "prof1", "profile", "pending"),
    )
    with pytest.raises(Exception):
        cur.execute(
            "INSERT INTO runtime_binding (id, enterprise_id, owner_type, owner_id, profile_name, runtime_kind, sync_status) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s)",
            ("rb_002", "ent_rb2", "employee", "emp_001", "prof2", "profile", "synced"),
        )
    cur.close()


def test_run_event_unique_cursor_constraint(db_conn):
    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s,%s,%s,%s)",
                ("ent_re", "ent-re", "Test", "u1"))
    cur.execute("INSERT INTO team_run (id, enterprise_id, trigger_type, status) VALUES (%s,%s,%s,%s)",
                ("run_re", "ent_re", "manual_run", "running"))
    cur.execute(
        "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s)",
        ("re_001", "ent_re", "run_re", 1, "run_created", "session", "ses_001"),
    )
    with pytest.raises(Exception):
        cur.execute(
            "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s)",
            ("re_002", "ent_re", "run_re", 1, "run_started", "session", "ses_001"),
        )
    cur.close()


def test_run_event_on_conflict_do_nothing_is_safe(db_conn):
    """INSERT ... ON CONFLICT DO NOTHING via repo should not raise on duplicate cursor."""
    from team_panel.repositories.run_event_repo import RunEventRepo
    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s,%s,%s,%s)",
                ("ent_dedup", "ent-dedup", "Test", "u1"))
    cur.execute("INSERT INTO team_run (id, enterprise_id, trigger_type, status) VALUES (%s,%s,%s,%s)",
                ("run_dedup", "ent_dedup", "manual_run", "running"))
    cur.close()

    repo = RunEventRepo(db_conn.cursor())
    evt = RunEvent(id="re_a", enterprise_id="ent_dedup", run_id="run_dedup",
                   cursor_no=5, event_type="run_created", source_type="session", source_id="s1")
    repo.create(evt)
    # Duplicate cursor should not raise, just be a no-op
    evt2 = RunEvent(id="re_b", enterprise_id="ent_dedup", run_id="run_dedup",
                    cursor_no=5, event_type="run_started", source_type="session", source_id="s1")
    repo.create(evt2)  # must not raise


# -- Expected indexes --

def test_scheduled_job_has_expected_indexes(db_conn):
    cur = db_conn.cursor()
    cur.execute(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'scheduled_job'")
    names = {r[0] for r in cur.fetchall()}
    assert "uk_job_employee_name" in names
    assert "idx_job_enterprise_status" in names
    assert "idx_job_employee" in names
    assert "idx_job_runtime" in names
    cur.close()


def test_runtime_binding_has_expected_indexes(db_conn):
    cur = db_conn.cursor()
    cur.execute(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'runtime_binding'")
    names = {r[0] for r in cur.fetchall()}
    assert "uk_runtime_binding_owner" in names
    assert "idx_runtime_binding_profile" in names
    assert "idx_runtime_binding_task" in names
    assert "idx_runtime_binding_job" in names
    assert "idx_runtime_binding_session" in names
    assert "idx_runtime_binding_sync" in names
    cur.close()


def test_run_event_has_expected_indexes(db_conn):
    cur = db_conn.cursor()
    cur.execute(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'run_event'")
    names = {r[0] for r in cur.fetchall()}
    assert "uk_run_event_run_cursor" in names
    assert "idx_run_event_run_ts" in names
    assert "idx_run_event_type" in names
    assert "idx_run_event_source" in names
    cur.close()


def test_audit_event_has_expected_indexes(db_conn):
    cur = db_conn.cursor()
    cur.execute(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'audit_event'")
    names = {r[0] for r in cur.fetchall()}
    assert "idx_audit_enterprise_created" in names
    assert "idx_audit_target" in names
    assert "idx_audit_event_type" in names
    cur.close()


# ═══════════════════════════════════════════════════════════════════
# T08: Repository persistence tests
# ═══════════════════════════════════════════════════════════════════

def _seed_enterprise(cur):
    from team_panel.repositories.enterprise_repo import EnterpriseRepo
    from team_panel.domain.entities import Enterprise
    EnterpriseRepo(cur).create(
        Enterprise(id="ent_001", slug="test", name="Test Enterprise",
                   status="active", owner_user_id="u1"))


def _seed_employee(cur):
    from team_panel.repositories.employee_repo import EmployeeRepo
    from team_panel.domain.entities import Employee
    EmployeeRepo(cur).create(
        Employee(id="emp_001", enterprise_id="ent_001",
                 profile_name="ent001-test-001", display_name="Test Agent",
                 status="active"))


def _seed_team_run(cur):
    cur.execute(
        "INSERT INTO team_run (id, enterprise_id, trigger_type, status) "
        "VALUES (%s,%s,%s,%s)",
        ("run_001", "ent_001", "manual_run", "running"))


# ── scheduled_job repo ──

def test_scheduled_job_repo_create_and_get(db_conn):
    from team_panel.repositories.scheduled_job_repo import ScheduledJobRepo
    _seed_enterprise(db_conn.cursor())
    _seed_employee(db_conn.cursor())

    repo = ScheduledJobRepo(db_conn.cursor())
    job = ScheduledJob(id="sj_001", enterprise_id="ent_001", employee_id="emp_001",
                       name="Daily Report", schedule_expr="0 9 * * *",
                       status="draft")
    repo.create(job)

    loaded = repo.get_by_id("sj_001")
    assert loaded is not None
    assert loaded.id == "sj_001"
    assert loaded.name == "Daily Report"
    assert loaded.status == "draft"
    assert loaded.max_consecutive_failures == 3


def test_scheduled_job_repo_get_nonexistent(db_conn):
    from team_panel.repositories.scheduled_job_repo import ScheduledJobRepo
    repo = ScheduledJobRepo(db_conn.cursor())
    assert repo.get_by_id("nonexistent_job") is None


def test_scheduled_job_repo_list_by_enterprise(db_conn):
    from team_panel.repositories.scheduled_job_repo import ScheduledJobRepo
    _seed_enterprise(db_conn.cursor())
    _seed_employee(db_conn.cursor())

    repo = ScheduledJobRepo(db_conn.cursor())
    repo.create(ScheduledJob(id="j1", enterprise_id="ent_001", employee_id="emp_001",
                             name="Job A", schedule_expr="0 9 * * *"))
    repo.create(ScheduledJob(id="j2", enterprise_id="ent_001", employee_id="emp_001",
                             name="Job B", schedule_expr="0 18 * * *"))

    results = repo.list_by_enterprise("ent_001")
    assert len(results) == 2
    ids = {j.id for j in results}
    assert ids == {"j1", "j2"}


def test_scheduled_job_repo_list_by_employee(db_conn):
    from team_panel.repositories.scheduled_job_repo import ScheduledJobRepo
    _seed_enterprise(db_conn.cursor())
    _seed_employee(db_conn.cursor())

    repo = ScheduledJobRepo(db_conn.cursor())
    repo.create(ScheduledJob(id="j3", enterprise_id="ent_001", employee_id="emp_001",
                             name="Job C", schedule_expr="0 12 * * *"))

    results = repo.list_by_employee("emp_001")
    assert len(results) == 1
    assert results[0].id == "j3"


def test_scheduled_job_repo_update_status(db_conn):
    from team_panel.repositories.scheduled_job_repo import ScheduledJobRepo
    _seed_enterprise(db_conn.cursor())
    _seed_employee(db_conn.cursor())

    repo = ScheduledJobRepo(db_conn.cursor())
    job = ScheduledJob(id="j4", enterprise_id="ent_001", employee_id="emp_001",
                       name="Job D", schedule_expr="* * * * *", status="draft")
    repo.create(job)

    job.enable()
    repo.update_status(job)

    loaded = repo.get_by_id("j4")
    assert loaded.status == "enabled"


def test_scheduled_job_repo_delete(db_conn):
    from team_panel.repositories.scheduled_job_repo import ScheduledJobRepo
    _seed_enterprise(db_conn.cursor())
    _seed_employee(db_conn.cursor())

    repo = ScheduledJobRepo(db_conn.cursor())
    repo.create(ScheduledJob(id="j5", enterprise_id="ent_001", employee_id="emp_001",
                             name="Job E", schedule_expr="* * * * *"))
    repo.delete("j5")

    loaded = repo.get_by_id("j5")
    assert loaded is not None
    assert loaded.deleted_at is not None


# ── runtime_binding repo ──

def test_runtime_binding_repo_create_and_get(db_conn):
    from team_panel.repositories.runtime_binding_repo import RuntimeBindingRepo
    _seed_enterprise(db_conn.cursor())

    repo = RuntimeBindingRepo(db_conn.cursor())
    binding = RuntimeBinding(
        id="rb_001", enterprise_id="ent_001",
        owner_type="employee", owner_id="emp_001",
        profile_name="worker-1", runtime_kind="profile",
    )
    repo.create(binding)

    loaded = repo.get_by_id("rb_001")
    assert loaded is not None
    assert loaded.owner_type == "employee"
    assert loaded.owner_id == "emp_001"
    assert loaded.profile_name == "worker-1"
    assert loaded.sync_status == "pending"
    assert loaded.runtime_source_cursor is None


def test_runtime_binding_repo_get_nonexistent(db_conn):
    from team_panel.repositories.runtime_binding_repo import RuntimeBindingRepo
    repo = RuntimeBindingRepo(db_conn.cursor())
    assert repo.get_by_id("nonexistent_rb") is None


def test_runtime_binding_repo_get_by_owner(db_conn):
    from team_panel.repositories.runtime_binding_repo import RuntimeBindingRepo
    _seed_enterprise(db_conn.cursor())

    repo = RuntimeBindingRepo(db_conn.cursor())
    repo.create(RuntimeBinding(
        id="rb_002", enterprise_id="ent_001",
        owner_type="scheduled_job", owner_id="sj_001",
        profile_name="cron-worker", runtime_kind="cron_job",
    ))

    loaded = repo.get_by_owner("scheduled_job", "sj_001")
    assert loaded is not None
    assert loaded.id == "rb_002"
    assert loaded.runtime_kind == "cron_job"

    assert repo.get_by_owner("scheduled_job", "nonexistent") is None


def test_runtime_binding_repo_update_sync(db_conn):
    from team_panel.repositories.runtime_binding_repo import RuntimeBindingRepo
    _seed_enterprise(db_conn.cursor())

    repo = RuntimeBindingRepo(db_conn.cursor())
    binding = RuntimeBinding(
        id="rb_003", enterprise_id="ent_001",
        owner_type="team_run", owner_id="run_001",
        profile_name="runner", runtime_kind="session",
    )
    repo.create(binding)

    binding.mark_synced()
    binding.advance_cursor(42)
    binding.runtime_source_cursor = "cursor-abc-123"
    repo.update_sync(binding)

    loaded = repo.get_by_id("rb_003")
    assert loaded.sync_status == "synced"
    assert loaded.event_cursor == 42
    assert loaded.runtime_source_cursor == "cursor-abc-123"


def test_runtime_binding_repo_list_by_sync_status(db_conn):
    from team_panel.repositories.runtime_binding_repo import RuntimeBindingRepo
    _seed_enterprise(db_conn.cursor())

    repo = RuntimeBindingRepo(db_conn.cursor())
    repo.create(RuntimeBinding(
        id="rb_004", enterprise_id="ent_001",
        owner_type="employee", owner_id="emp_a",
        profile_name="wa", runtime_kind="profile",
        sync_status="pending",
    ))
    repo.create(RuntimeBinding(
        id="rb_005", enterprise_id="ent_001",
        owner_type="employee", owner_id="emp_b",
        profile_name="wb", runtime_kind="profile",
        sync_status="synced",
    ))

    pending = repo.list_by_sync_status("pending")
    assert len(pending) == 1
    assert pending[0].id == "rb_004"

    synced = repo.list_by_sync_status("synced")
    assert len(synced) == 1
    assert synced[0].id == "rb_005"


# ── run_event repo ──

def test_run_event_repo_create_and_get(db_conn):
    from team_panel.repositories.run_event_repo import RunEventRepo
    _seed_enterprise(db_conn.cursor())
    _seed_team_run(db_conn.cursor())

    repo = RunEventRepo(db_conn.cursor())
    evt = RunEvent(id="ev_001", enterprise_id="ent_001", run_id="run_001",
                   cursor_no=1, event_type="run_created",
                   source_type="session", source_id="s1",
                   preview_text="Run started")
    repo.create(evt)

    loaded = repo.get_by_id("ev_001")
    assert loaded is not None
    assert loaded.run_id == "run_001"
    assert loaded.cursor_no == 1
    assert loaded.event_type == "run_created"
    assert loaded.preview_text == "Run started"


def test_run_event_repo_cursor_based_pagination(db_conn):
    from team_panel.repositories.run_event_repo import RunEventRepo
    _seed_enterprise(db_conn.cursor())
    _seed_team_run(db_conn.cursor())

    repo = RunEventRepo(db_conn.cursor())
    for i in range(1, 6):
        repo.create(RunEvent(
            id=f"ev_{i:03d}", enterprise_id="ent_001", run_id="run_001",
            cursor_no=i, event_type="message_delta",
            source_type="session", source_id="s1",
        ))

    # After cursor 2, limit 2
    page = repo.list_by_run("run_001", after_cursor=2, limit=2)
    assert len(page) == 2
    assert page[0].cursor_no == 3
    assert page[1].cursor_no == 4


def test_run_event_repo_get_max_cursor(db_conn):
    from team_panel.repositories.run_event_repo import RunEventRepo
    _seed_enterprise(db_conn.cursor())
    _seed_team_run(db_conn.cursor())

    repo = RunEventRepo(db_conn.cursor())
    assert repo.get_max_cursor("run_001") == 0

    repo.create(RunEvent(id="ev_max1", enterprise_id="ent_001", run_id="run_001",
                         cursor_no=7, event_type="run_created",
                         source_type="session", source_id="s1"))
    repo.create(RunEvent(id="ev_max2", enterprise_id="ent_001", run_id="run_001",
                         cursor_no=12, event_type="message_delta",
                         source_type="session", source_id="s1"))

    assert repo.get_max_cursor("run_001") == 12


def test_run_event_repo_get_nonexistent(db_conn):
    from team_panel.repositories.run_event_repo import RunEventRepo
    repo = RunEventRepo(db_conn.cursor())
    assert repo.get_by_id("nonexistent_ev") is None


# ── audit_event repo ──

def test_audit_event_repo_create_and_get(db_conn):
    from team_panel.repositories.audit_event_repo import AuditEventRepo
    _seed_enterprise(db_conn.cursor())

    repo = AuditEventRepo(db_conn.cursor())
    evt = AuditEvent(
        id="ae_001", enterprise_id="ent_001",
        actor_type="user", actor_id="usr_001",
        event_type="employee.created",
        target_type="employee", target_id="emp_001",
        payload_json='{"created_from": "talent_market"}',
    )
    repo.create(evt)

    loaded = repo.get_by_id("ae_001")
    assert loaded is not None
    assert loaded.actor_type == "user"
    assert loaded.actor_id == "usr_001"
    assert loaded.event_type == "employee.created"
    assert loaded.target_type == "employee"
    assert loaded.target_id == "emp_001"
    assert "talent_market" in loaded.payload_json


def test_audit_event_repo_get_nonexistent(db_conn):
    from team_panel.repositories.audit_event_repo import AuditEventRepo
    repo = AuditEventRepo(db_conn.cursor())
    assert repo.get_by_id("nonexistent_ae") is None


def test_audit_event_repo_list_by_enterprise(db_conn):
    from team_panel.repositories.audit_event_repo import AuditEventRepo
    _seed_enterprise(db_conn.cursor())

    repo = AuditEventRepo(db_conn.cursor())
    repo.create(AuditEvent(
        id="ae_a", enterprise_id="ent_001",
        actor_type="system", actor_id="sys",
        event_type="job.enabled", target_type="scheduled_job", target_id="j1",
    ))
    repo.create(AuditEvent(
        id="ae_b", enterprise_id="ent_001",
        actor_type="user", actor_id="usr_002",
        event_type="employee.archived", target_type="employee", target_id="emp_002",
    ))

    results = repo.list_by_enterprise("ent_001")
    assert len(results) == 2
    ids = {e.id for e in results}
    assert ids == {"ae_a", "ae_b"}


def test_audit_event_repo_list_by_target(db_conn):
    from team_panel.repositories.audit_event_repo import AuditEventRepo
    _seed_enterprise(db_conn.cursor())

    repo = AuditEventRepo(db_conn.cursor())
    repo.create(AuditEvent(
        id="ae_c", enterprise_id="ent_001",
        actor_type="employee", actor_id="emp_admin",
        event_type="employee.paused", target_type="employee", target_id="emp_003",
    ))
    repo.create(AuditEvent(
        id="ae_d", enterprise_id="ent_001",
        actor_type="user", actor_id="usr_003",
        event_type="employee.resumed", target_type="employee", target_id="emp_003",
    ))

    results = repo.list_by_target("employee", "emp_003")
    assert len(results) == 2
    assert {e.id for e in results} == {"ae_c", "ae_d"}


def test_audit_event_repo_list_by_target_empty(db_conn):
    from team_panel.repositories.audit_event_repo import AuditEventRepo
    _seed_enterprise(db_conn.cursor())

    repo = AuditEventRepo(db_conn.cursor())
    assert repo.list_by_target("employee", "no_such_emp") == []
