"""L1-S03 Conversation / TeamRun / TeamTask aggregate tests.

Covers T01-T08 per the L1 plan:
  T01 - conversation status valid values
  T02 - private vs group conversation type semantics
  T03 - team_run status lifecycle queued->routing->submitting->running->succeeded/failed/cancelled
  T04 - team_task status lifecycle planned->queued->running->waiting_deps->succeeded/failed/cancelled
  T05 - ConversationMember entity
  T06 - conversation status transitions and invalid transitions
  T07 - migration creates conversation/conversation_member/team_run/team_task tables
  T08 - repository persistence for new aggregates
"""

import ast
import uuid
import pytest

from team_panel.domain.entities import (
    Conversation,
    ConversationMember,
    TeamRun,
    TeamTask,
)


# Helpers

_VALID_CONVERSATION_STATUSES = {"draft", "active", "paused", "muted", "archived"}
_VALID_TEAM_RUN_STATUSES = {"queued", "routing", "submitting", "running", "waiting_human", "succeeded", "failed", "cancelled"}
_VALID_TEAM_TASK_STATUSES = {"planned", "queued", "running", "waiting_deps", "succeeded", "failed", "cancelled"}


def _make_conversation(**kw):
    defaults = dict(id=f"conv_{uuid.uuid4().hex[:8]}", enterprise_id="ent_001", created_by="usr_001")
    defaults.update(kw)
    return Conversation(**defaults)


def _make_team_run(**kw):
    defaults = dict(id=f"run_{uuid.uuid4().hex[:8]}", enterprise_id="ent_001")
    defaults.update(kw)
    return TeamRun(**defaults)


def _make_team_task(**kw):
    defaults = dict(id=f"task_{uuid.uuid4().hex[:8]}", run_id="run_001")
    defaults.update(kw)
    return TeamTask(**defaults)


# ==============================================================
# T01: conversation status valid values
# ==============================================================

def test_conversation_status_must_be_valid():
    """Conversation status must be one of the 5 fixed values per spec."""
    conv = _make_conversation()
    assert conv.status == "draft"
    assert conv.status in _VALID_CONVERSATION_STATUSES

    for st in _VALID_CONVERSATION_STATUSES:
        conv = _make_conversation(status=st)
        assert conv.status == st
        assert conv.status in _VALID_CONVERSATION_STATUSES


def test_conversation_default_status_is_draft():
    conv = _make_conversation()
    assert conv.status == "draft"


# ==============================================================
# T02: private vs group conversation type semantics
# ==============================================================

def test_conversation_type_private_or_group():
    conv = _make_conversation(type="private")
    assert conv.is_private() is True
    assert conv.is_group() is False

    conv = _make_conversation(type="group")
    assert conv.is_private() is False
    assert conv.is_group() is True


def test_conversation_default_type_is_private():
    conv = _make_conversation()
    assert conv.type == "private"
    assert conv.is_private() is True


def test_private_conversation_has_entry_employee():
    conv = _make_conversation(type="private", entry_employee_id="emp_001")
    assert conv.is_private() is True
    assert conv.entry_employee_id == "emp_001"


def test_group_conversation_has_no_entry_employee():
    conv = _make_conversation(type="group")
    assert conv.is_group() is True
    assert conv.entry_employee_id is None


# ==============================================================
# T03: team_run status lifecycle
# ==============================================================

def test_team_run_status_lifecycle_happy_path():
    """queued -> routing -> submitting -> running -> succeeded."""
    run = _make_team_run(status="queued")
    assert run.status == "queued"
    assert not run.is_terminal()

    run.start_routing()
    assert run.status == "routing"

    run.submit()
    assert run.status == "submitting"

    run.start_running()
    assert run.status == "running"

    run.mark_succeeded()
    assert run.status == "succeeded"
    assert run.is_terminal()


def test_team_run_status_lifecycle_to_failed():
    """queued -> routing -> submitting -> running -> failed."""
    run = _make_team_run(status="queued")
    run.start_routing()
    run.submit()
    run.start_running()
    run.mark_failed(error_code="E001", error_message="something broke")
    assert run.status == "failed"
    assert run.error_code == "E001"
    assert run.error_message == "something broke"
    assert run.is_terminal()


def test_team_run_status_lifecycle_to_cancelled():
    """queued -> routing -> cancelled (cancel from any non-terminal)."""
    run = _make_team_run(status="queued")
    run.start_routing()
    run.cancel()
    assert run.status == "cancelled"
    assert run.is_terminal()


def test_team_run_waiting_human_cycle():
    """running -> waiting_human -> running."""
    run = _make_team_run(status="queued")
    run.start_routing()
    run.submit()
    run.start_running()
    assert run.status == "running"

    run.wait_for_human()
    assert run.status == "waiting_human"

    run.start_running()
    assert run.status == "running"


# -- Invalid transitions --

def test_team_run_cannot_start_routing_from_non_queued():
    for st in ("routing", "submitting", "running", "succeeded", "failed", "cancelled"):
        run = _make_team_run(status=st)
        with pytest.raises(ValueError, match="Cannot start routing"):
            run.start_routing()


def test_team_run_cannot_submit_from_non_routing():
    for st in ("queued", "submitting", "running", "succeeded"):
        run = _make_team_run(status=st)
        with pytest.raises(ValueError, match="Cannot submit"):
            run.submit()


def test_team_run_cannot_start_running_from_bad_states():
    for st in ("queued", "routing", "running", "succeeded", "failed", "cancelled"):
        run = _make_team_run(status=st)
        with pytest.raises(ValueError, match="Cannot start running"):
            run.start_running()


def test_team_run_cannot_wait_for_human_from_non_running():
    for st in ("queued", "routing", "submitting", "waiting_human", "succeeded"):
        run = _make_team_run(status=st)
        with pytest.raises(ValueError, match="Cannot wait_for_human"):
            run.wait_for_human()


def test_team_run_cannot_mark_succeeded_when_terminal():
    for st in ("succeeded", "failed", "cancelled"):
        run = _make_team_run(status=st)
        with pytest.raises(ValueError, match="Cannot mark succeeded"):
            run.mark_succeeded()


def test_team_run_cannot_mark_failed_when_terminal():
    for st in ("succeeded", "failed", "cancelled"):
        run = _make_team_run(status=st)
        with pytest.raises(ValueError, match="Cannot mark failed"):
            run.mark_failed()


def test_team_run_cannot_cancel_when_terminal():
    for st in ("succeeded", "failed", "cancelled"):
        run = _make_team_run(status=st)
        with pytest.raises(ValueError, match="Cannot cancel"):
            run.cancel()


def test_team_run_is_runnable():
    run = _make_team_run(status="queued")
    assert run.is_runnable() is True
    run.start_routing()
    assert run.is_runnable() is True
    run.submit()
    assert run.is_runnable() is True
    run.start_running()
    assert run.is_runnable() is True

    run.mark_succeeded()
    assert run.is_runnable() is False

    run2 = _make_team_run(status="cancelled")
    assert run2.is_runnable() is False


# ==============================================================
# T04: team_task status lifecycle
# ==============================================================

def test_team_task_status_lifecycle_happy_path():
    """planned -> queued -> running -> succeeded."""
    task = _make_team_task(status="planned")
    assert task.status == "planned"
    assert not task.is_terminal()

    task.queue()
    assert task.status == "queued"

    task.start_running()
    assert task.status == "running"

    task.mark_succeeded()
    assert task.status == "succeeded"
    assert task.is_terminal()


def test_team_task_status_lifecycle_to_failed():
    """planned -> queued -> running -> failed."""
    task = _make_team_task(status="planned")
    task.queue()
    task.start_running()
    task.mark_failed()
    assert task.status == "failed"
    assert task.is_terminal()


def test_team_task_status_lifecycle_to_cancelled():
    """planned -> queued -> cancelled."""
    task = _make_team_task(status="planned")
    task.queue()
    task.cancel()
    assert task.status == "cancelled"
    assert task.is_terminal()


def test_team_task_waiting_deps_cycle():
    """running -> waiting_deps -> running."""
    task = _make_team_task(status="planned")
    task.queue()
    task.start_running()
    assert task.status == "running"

    task.wait_for_deps()
    assert task.status == "waiting_deps"

    task.start_running()
    assert task.status == "running"


# -- Invalid transitions --

def test_team_task_cannot_queue_from_non_planned():
    for st in ("queued", "running", "waiting_deps", "succeeded", "failed", "cancelled"):
        task = _make_team_task(status=st)
        with pytest.raises(ValueError, match="Cannot queue"):
            task.queue()


def test_team_task_cannot_start_running_from_bad_states():
    for st in ("planned", "running", "succeeded", "failed", "cancelled"):
        task = _make_team_task(status=st)
        with pytest.raises(ValueError, match="Cannot start running"):
            task.start_running()


def test_team_task_cannot_wait_for_deps_from_non_running():
    for st in ("planned", "queued", "waiting_deps", "succeeded"):
        task = _make_team_task(status=st)
        with pytest.raises(ValueError, match="Cannot wait_for_deps"):
            task.wait_for_deps()


def test_team_task_cannot_mark_succeeded_when_terminal():
    for st in ("succeeded", "failed", "cancelled"):
        task = _make_team_task(status=st)
        with pytest.raises(ValueError, match="Cannot mark succeeded"):
            task.mark_succeeded()


def test_team_task_cannot_mark_failed_when_terminal():
    for st in ("succeeded", "failed", "cancelled"):
        task = _make_team_task(status=st)
        with pytest.raises(ValueError, match="Cannot mark failed"):
            task.mark_failed()


def test_team_task_cannot_cancel_when_terminal():
    for st in ("succeeded", "failed", "cancelled"):
        task = _make_team_task(status=st)
        with pytest.raises(ValueError, match="Cannot cancel"):
            task.cancel()


# ==============================================================
# T05: ConversationMember entity
# ==============================================================

def test_conversation_member_defaults():
    m = ConversationMember(member_id="cm_001", conversation_id="conv_001")
    assert m.member_id == "cm_001"
    assert m.conversation_id == "conv_001"
    assert m.member_type == "employee"
    assert m.role == "participant"
    assert m.status == "active"


def test_conversation_member_remove():
    m = ConversationMember(member_id="cm_001", conversation_id="conv_001")
    m.remove()
    assert m.status == "removed"


def test_conversation_member_cannot_remove_twice():
    m = ConversationMember(member_id="cm_001", conversation_id="conv_001", status="removed")
    with pytest.raises(ValueError, match="Already removed"):
        m.remove()


# ==============================================================
# T06: Conversation status transitions
# ==============================================================

def test_conversation_activate_from_draft():
    conv = _make_conversation(status="draft")
    conv.activate()
    assert conv.status == "active"


def test_conversation_activate_from_paused():
    conv = _make_conversation(status="paused")
    conv.activate()
    assert conv.status == "active"


def test_conversation_activate_from_muted():
    conv = _make_conversation(status="muted")
    conv.activate()
    assert conv.status == "active"


def test_conversation_cannot_activate_from_archived():
    conv = _make_conversation(status="archived")
    with pytest.raises(ValueError, match="Cannot activate"):
        conv.activate()


def test_conversation_pause_from_active():
    conv = _make_conversation(status="active")
    conv.pause()
    assert conv.status == "paused"


def test_conversation_cannot_pause_from_non_active():
    for st in ("draft", "paused", "muted", "archived"):
        conv = _make_conversation(status=st)
        with pytest.raises(ValueError, match="Cannot pause"):
            conv.pause()


def test_conversation_resume_from_paused():
    conv = _make_conversation(status="paused")
    conv.resume()
    assert conv.status == "active"


def test_conversation_cannot_resume_from_non_paused():
    for st in ("draft", "active", "muted", "archived"):
        conv = _make_conversation(status=st)
        with pytest.raises(ValueError, match="Cannot resume"):
            conv.resume()


def test_conversation_mute_from_active():
    conv = _make_conversation(status="active")
    conv.mute()
    assert conv.status == "muted"


def test_conversation_cannot_mute_from_non_active():
    for st in ("draft", "paused", "muted", "archived"):
        conv = _make_conversation(status=st)
        with pytest.raises(ValueError, match="Cannot mute"):
            conv.mute()


def test_conversation_unmute_from_muted():
    conv = _make_conversation(status="muted")
    conv.unmute()
    assert conv.status == "active"


def test_conversation_cannot_unmute_from_non_muted():
    for st in ("draft", "active", "paused", "archived"):
        conv = _make_conversation(status=st)
        with pytest.raises(ValueError, match="Cannot unmute"):
            conv.unmute()


def test_conversation_archive_from_active():
    conv = _make_conversation(status="active")
    conv.archive()
    assert conv.status == "archived"


def test_conversation_archive_from_paused():
    conv = _make_conversation(status="paused")
    conv.archive()
    assert conv.status == "archived"


def test_conversation_archive_from_muted():
    conv = _make_conversation(status="muted")
    conv.archive()
    assert conv.status == "archived"


def test_conversation_cannot_archive_twice():
    conv = _make_conversation(status="archived")
    with pytest.raises(ValueError, match="Already archived"):
        conv.archive()


# -- Migration table existence tests --

def test_migration_creates_conversation_table(db_conn):
    cur = db_conn.cursor()
    cur.execute("SELECT table_name FROM information_schema.tables WHERE table_name = 'conversation'")
    assert cur.fetchone() is not None
    cur.close()


def test_migration_creates_conversation_member_table(db_conn):
    cur = db_conn.cursor()
    cur.execute("SELECT table_name FROM information_schema.tables WHERE table_name = 'conversation_member'")
    assert cur.fetchone() is not None
    cur.close()


def test_migration_creates_team_run_table(db_conn):
    cur = db_conn.cursor()
    cur.execute("SELECT table_name FROM information_schema.tables WHERE table_name = 'team_run'")
    assert cur.fetchone() is not None
    cur.close()


def test_migration_creates_team_task_table(db_conn):
    cur = db_conn.cursor()
    cur.execute("SELECT table_name FROM information_schema.tables WHERE table_name = 'team_task'")
    assert cur.fetchone() is not None
    cur.close()


def test_conversation_check_constraint_rejects_invalid_status(db_conn):
    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s, %s, %s, %s)",
                ("ent_conv", "ent-conv", "Test", "usr_001"))
    with pytest.raises(Exception):
        cur.execute(
            "INSERT INTO conversation (id, enterprise_id, type, status, created_by) "
            "VALUES (%s, %s, %s, %s, %s)",
            ("conv_bad", "ent_conv", "private", "invalid_status", "usr_001"),
        )
    cur.close()


def test_team_run_check_constraint_rejects_invalid_status(db_conn):
    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s, %s, %s, %s)",
                ("ent_run", "ent-run", "Test", "usr_001"))
    with pytest.raises(Exception):
        cur.execute(
            "INSERT INTO team_run (id, enterprise_id, trigger_type, status) "
            "VALUES (%s, %s, %s, %s)",
            ("run_bad", "ent_run", "manual_run", "bad_status"),
        )
    cur.close()


def test_team_task_check_constraint_rejects_invalid_status(db_conn):
    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s, %s, %s, %s)",
                ("ent_task_ck", "ent-task-ck", "Test", "usr_001"))
    cur.execute(
        "INSERT INTO team_run (id, enterprise_id, trigger_type, status) "
        "VALUES (%s, %s, %s, %s)",
        ("run_tt", "ent_task_ck", "manual_run", "queued"),
    )
    with pytest.raises(Exception):
        cur.execute(
            "INSERT INTO team_task (id, run_id, status) VALUES (%s, %s, %s)",
            ("task_bad", "run_tt", "bad_status"),
        )
    cur.close()


# -- Index existence --

def test_conversation_has_expected_indexes(db_conn):
    cur = db_conn.cursor()
    cur.execute("SELECT indexname FROM pg_indexes WHERE tablename = 'conversation'")
    indexes = {r[0] for r in cur.fetchall()}
    expected = {"uk_private_conversation", "idx_conversation_enterprise_status",
                "idx_conversation_latest_run", "idx_conversation_last_message"}
    assert expected.issubset(indexes), f"Missing indexes: {expected - indexes}"
    cur.close()


def test_team_run_has_expected_indexes(db_conn):
    cur = db_conn.cursor()
    cur.execute("SELECT indexname FROM pg_indexes WHERE tablename = 'team_run'")
    indexes = {r[0] for r in cur.fetchall()}
    expected = {"idx_team_run_idempotency", "idx_run_enterprise_status",
                "idx_run_conversation", "idx_run_employee", "idx_run_job"}
    assert expected.issubset(indexes), f"Missing indexes: {expected - indexes}"
    cur.close()


def test_team_task_has_expected_indexes(db_conn):
    cur = db_conn.cursor()
    cur.execute("SELECT indexname FROM pg_indexes WHERE tablename = 'team_task'")
    indexes = {r[0] for r in cur.fetchall()}
    expected = {"idx_team_task_run", "idx_team_task_parent",
                "idx_team_task_assignee", "idx_team_task_runtime"}
    assert expected.issubset(indexes), f"Missing indexes: {expected - indexes}"
    cur.close()


# ==============================================================
# T08: Repository persistence
# ==============================================================

def test_conversation_repo_create_and_get(db_conn):
    from team_panel.repositories.conversation_repo import ConversationRepo
    repo = ConversationRepo(db_conn.cursor())

    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s, %s, %s, %s)",
                ("ent_conv_repo", "ent-conv-repo", "Test", "usr_001"))
    cur.close()

    conv = Conversation(id="conv_001", enterprise_id="ent_conv_repo", type="private",
                        status="draft", title="Test Conversation", created_by="usr_001")
    repo.create(conv)

    loaded = repo.get_by_id("conv_001")
    assert loaded is not None
    assert loaded.id == "conv_001"
    assert loaded.enterprise_id == "ent_conv_repo"
    assert loaded.type == "private"
    assert loaded.status == "draft"
    assert loaded.title == "Test Conversation"
    assert loaded.deleted_at is None


def test_conversation_repo_get_nonexistent(db_conn):
    from team_panel.repositories.conversation_repo import ConversationRepo
    repo = ConversationRepo(db_conn.cursor())
    assert repo.get_by_id("nonexistent_conv") is None


def test_conversation_repo_list_by_enterprise(db_conn):
    from team_panel.repositories.conversation_repo import ConversationRepo
    repo = ConversationRepo(db_conn.cursor())

    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s, %s, %s, %s)",
                ("ent_conv_list", "ent-conv-list", "Test", "usr_001"))
    cur.close()

    repo.create(Conversation(id="c1", enterprise_id="ent_conv_list", type="private", status="draft", created_by="u1"))
    repo.create(Conversation(id="c2", enterprise_id="ent_conv_list", type="group", status="active", created_by="u1"))

    results = repo.list_by_enterprise("ent_conv_list")
    assert len(results) == 2
    ids = {c.id for c in results}
    assert ids == {"c1", "c2"}


def test_conversation_repo_list_private_by_employee(db_conn):
    """Private conversations for one employee, newest-first, excluding group/deleted/other-employee."""
    from team_panel.repositories.conversation_repo import ConversationRepo
    repo = ConversationRepo(db_conn.cursor())

    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s, %s, %s, %s)",
                ("ent_emp_hist", "ent-emp-hist", "Test", "usr_001"))
    for emp_id in ("emp_A", "emp_B"):
        cur.execute(
            "INSERT INTO employee (id, enterprise_id, profile_name, display_name, role_name, status, created_from) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (emp_id, "ent_emp_hist", emp_id, emp_id, "tester", "active", "manual"),
        )
    cur.close()

    # Two private chats for emp_A, one group, one private for emp_B, one soft-deleted.
    repo.create(Conversation(id="h1", enterprise_id="ent_emp_hist", type="private", status="active",
                             entry_employee_id="emp_A", created_by="u1"))
    repo.create(Conversation(id="h2", enterprise_id="ent_emp_hist", type="private", status="archived",
                             entry_employee_id="emp_A", created_by="u1"))
    repo.create(Conversation(id="hg", enterprise_id="ent_emp_hist", type="group", status="active",
                             entry_employee_id="emp_A", created_by="u1"))
    repo.create(Conversation(id="hb", enterprise_id="ent_emp_hist", type="private", status="active",
                             entry_employee_id="emp_B", created_by="u1"))
    repo.create(Conversation(id="hd", enterprise_id="ent_emp_hist", type="private", status="active",
                             entry_employee_id="emp_A", created_by="u1"))

    # Order h1 < h2 by last_message_at so newest-first puts h2 first.
    cur = db_conn.cursor()
    cur.execute("UPDATE conversation SET last_message_at = %s WHERE id = %s", ("2026-06-10 10:00:00+00", "h1"))
    cur.execute("UPDATE conversation SET last_message_at = %s WHERE id = %s", ("2026-06-14 10:00:00+00", "h2"))
    cur.execute("UPDATE conversation SET deleted_at = now() WHERE id = %s", ("hd",))
    cur.close()

    results = repo.list_private_by_employee("ent_emp_hist", "emp_A")
    ids = [c.id for c in results]
    assert ids == ["h2", "h1"]  # newest-first, group/other-employee/deleted excluded


def test_team_run_repo_create_and_get(db_conn):
    from team_panel.repositories.team_run_repo import TeamRunRepo
    repo = TeamRunRepo(db_conn.cursor())

    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s, %s, %s, %s)",
                ("ent_run_repo", "ent-run-repo", "Test", "usr_001"))
    cur.execute("INSERT INTO conversation (id, enterprise_id, type, status, created_by) VALUES (%s, %s, %s, %s, %s)",
                ("conv_run", "ent_run_repo", "private", "active", "usr_001"))
    cur.close()

    run = TeamRun(id="run_001", enterprise_id="ent_run_repo", conversation_id="conv_run",
                  trigger_type="private_message", status="queued")
    repo.create(run)

    loaded = repo.get_by_id("run_001")
    assert loaded is not None
    assert loaded.id == "run_001"
    assert loaded.enterprise_id == "ent_run_repo"
    assert loaded.conversation_id == "conv_run"
    assert loaded.status == "queued"
    assert loaded.trigger_type == "private_message"


def test_team_run_repo_update_status(db_conn):
    from team_panel.repositories.team_run_repo import TeamRunRepo
    repo = TeamRunRepo(db_conn.cursor())

    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s, %s, %s, %s)",
                ("ent_run_upd", "ent-run-upd", "Test", "usr_001"))
    cur.close()

    run = TeamRun(id="run_upd", enterprise_id="ent_run_upd", trigger_type="manual_run", status="queued")
    repo.create(run)

    run.start_routing()
    repo.update_status(run)

    loaded = repo.get_by_id("run_upd")
    assert loaded is not None
    assert loaded.status == "routing"


def test_team_task_repo_create_and_get(db_conn):
    from team_panel.repositories.team_task_repo import TeamTaskRepo
    repo = TeamTaskRepo(db_conn.cursor())

    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s, %s, %s, %s)",
                ("ent_task_repo", "ent-task-repo", "Test", "usr_001"))
    cur.execute("INSERT INTO team_run (id, enterprise_id, trigger_type, status) VALUES (%s, %s, %s, %s)",
                ("run_task", "ent_task_repo", "manual_run", "running"))
    cur.close()

    task = TeamTask(id="task_001", run_id="run_task", title="Test Task", status="planned")
    repo.create(task)

    loaded = repo.get_by_id("task_001")
    assert loaded is not None
    assert loaded.id == "task_001"
    assert loaded.run_id == "run_task"
    assert loaded.title == "Test Task"
    assert loaded.status == "planned"


def test_team_task_repo_list_by_run(db_conn):
    from team_panel.repositories.team_task_repo import TeamTaskRepo
    repo = TeamTaskRepo(db_conn.cursor())

    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s, %s, %s, %s)",
                ("ent_task_list2", "ent-task-list2", "Test", "usr_001"))
    cur.execute("INSERT INTO team_run (id, enterprise_id, trigger_type, status) VALUES (%s, %s, %s, %s)",
                ("run_task_list2", "ent_task_list2", "manual_run", "running"))
    cur.close()

    repo.create(TeamTask(id="t1", run_id="run_task_list2", title="Task 1", sequence_no=1, status="planned"))
    repo.create(TeamTask(id="t2", run_id="run_task_list2", title="Task 2", sequence_no=2, status="planned"))

    results = repo.list_by_run("run_task_list2")
    assert len(results) == 2
    assert results[0].id == "t1"
    assert results[1].id == "t2"


def test_team_task_repo_update_status(db_conn):
    from team_panel.repositories.team_task_repo import TeamTaskRepo
    repo = TeamTaskRepo(db_conn.cursor())

    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s, %s, %s, %s)",
                ("ent_task_upd2", "ent-task-upd2", "Test", "usr_001"))
    cur.execute("INSERT INTO team_run (id, enterprise_id, trigger_type, status) VALUES (%s, %s, %s, %s)",
                ("run_task_upd2", "ent_task_upd2", "manual_run", "running"))
    cur.close()

    task = TeamTask(id="task_upd2", run_id="run_task_upd2", status="planned")
    repo.create(task)

    task.queue()
    repo.update_status(task)

    loaded = repo.get_by_id("task_upd2")
    assert loaded is not None
    assert loaded.status == "queued"


def test_team_task_repo_update_status_persists_mirror_fields(db_conn):
    from team_panel.repositories.team_task_repo import TeamTaskRepo

    repo = TeamTaskRepo(db_conn.cursor())

    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s, %s, %s, %s)",
                ("ent_task_mirror", "ent-task-mirror", "Test", "usr_001"))
    cur.execute(
        "INSERT INTO agent_template (id, name, category_code, role_name, status, prompt_pack_json, default_model_json, default_binding_json, version_no, source_type) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (
            "tpl_task_mirror",
            "Mirror Template",
            "ops",
            "Operator",
            "published",
            "{}",
            "{}",
            "{}",
            1,
            "system",
        ),
    )
    cur.execute("INSERT INTO team_run (id, enterprise_id, trigger_type, status) VALUES (%s, %s, %s, %s)",
                ("run_task_mirror", "ent_task_mirror", "manual_run", "running"))
    cur.execute(
        "INSERT INTO employee (id, enterprise_id, template_id, profile_name, display_name, role_name, status, created_from) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
        ("emp_member", "ent_task_mirror", "tpl_task_mirror", "member-profile", "Member", "Analyst", "active", "talent_market"),
    )
    cur.close()

    parent = TeamTask(
        id="task_parent",
        run_id="run_task_mirror",
        title="Parent task",
        status="planned",
        sequence_no=1,
        runtime_task_id="runtime_parent_001",
    )
    repo.create(parent)

    task = TeamTask(
        id="task_mirror",
        run_id="run_task_mirror",
        title="Initial title",
        status="planned",
        sequence_no=2,
        runtime_task_id="runtime_child_001",
    )
    repo.create(task)

    task.parent_team_task_id = "task_parent"
    task.title = "Updated title"
    task.description = "Persist corrected description"
    task.assignee_employee_id = "emp_member"
    task.depth = 2
    task.input_payload_json = '{"title": "Updated title", "parent_task_id": "runtime_parent_001"}'
    task.queue()
    repo.update_status(task)

    loaded = repo.get_by_id("task_mirror")
    assert loaded is not None
    assert loaded.parent_team_task_id == "task_parent"
    assert loaded.title == "Updated title"
    assert loaded.description == "Persist corrected description"
    assert loaded.assignee_employee_id == "emp_member"
    assert loaded.depth == 2
    assert loaded.input_payload_json is not None
    assert ast.literal_eval(loaded.input_payload_json) == {
        "title": "Updated title",
        "parent_task_id": "runtime_parent_001",
    }
    assert loaded.status == "queued"


def test_conversation_member_uk_enforced(db_conn):
    """Unique constraint on (conversation_id, member_type, member_ref_id) is enforced."""
    cur = db_conn.cursor()
    cur.execute("INSERT INTO enterprise (id, slug, name, owner_user_id) VALUES (%s, %s, %s, %s)",
                ("ent_cm", "ent-cm", "Test", "usr_001"))
    cur.execute("INSERT INTO conversation (id, enterprise_id, type, status, created_by) VALUES (%s, %s, %s, %s, %s)",
                ("conv_cm", "ent_cm", "group", "active", "usr_001"))
    cur.execute(
        "INSERT INTO conversation_member (member_id, conversation_id, member_type, member_ref_id) "
        "VALUES (%s, %s, %s, %s)",
        ("cm_001", "conv_cm", "employee", "emp_001"),
    )
    with pytest.raises(Exception):
        cur.execute(
            "INSERT INTO conversation_member (member_id, conversation_id, member_type, member_ref_id) "
            "VALUES (%s, %s, %s, %s)",
            ("cm_002", "conv_cm", "employee", "emp_001"),
        )
    cur.close()
