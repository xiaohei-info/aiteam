"""L1-S05 Repository / UoW / Migration Bootstrapping tests.

Covers:
  - UoW commit persists data
  - UoW rollback discards changes
  - Migration runner from empty DB creates all expected tables
  - Migration runner idempotency
  - Repository smoke path through UoW
"""

import uuid

import psycopg2
import pytest

from team_panel.domain.entities import Enterprise
from team_panel.migrations.runner import apply_migrations, is_applied
from team_panel.transactions.uow import UnitOfWork


# ═══════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════

def _fresh_enterprise(**kw):
    defaults = dict(
        id=f"ent_{uuid.uuid4().hex[:8]}",
        slug=f"slug-{uuid.uuid4().hex[:8]}",
        name="Test Enterprise",
        owner_user_id="usr_001",
    )
    defaults.update(kw)
    return Enterprise(**defaults)


# ═══════════════════════════════════════════════════════════════════
# UoW commit / rollback tests
# ═══════════════════════════════════════════════════════════════════

def test_uow_commit_persists_data(db_conn):
    """UoW commit: data inserted inside the UoW is visible after commit."""
    ent = _fresh_enterprise()

    # ---- write inside UoW ----
    with UnitOfWork(db_conn) as uow:
        repo = uow.enterprises()
        repo.create(ent)
        # Enterprise must be visible within the same transaction
        reloaded = repo.get_by_id(ent.id)
        assert reloaded is not None
        assert reloaded.name == "Test Enterprise"

    assert uow.committed is True

    # ---- verify with a fresh cursor outside the UoW ----
    cur = db_conn.cursor()
    try:
        cur.execute("SELECT id, name FROM enterprise WHERE id = %s", (ent.id,))
        row = cur.fetchone()
        assert row is not None, "enterprise should be persisted after UoW commit"
        assert row[1] == "Test Enterprise"
    finally:
        cur.close()


def test_uow_rollback_discards_changes(db_conn):
    """UoW rollback: data inserted inside a failed UoW is NOT persisted."""
    ent = _fresh_enterprise()

    uow = None
    try:
        with UnitOfWork(db_conn) as uow:
            repo = uow.enterprises()
            repo.create(ent)
            # visible inside the transaction
            reloaded = repo.get_by_id(ent.id)
            assert reloaded is not None
            raise RuntimeError("forced rollback")
    except RuntimeError:
        pass  # expected

    assert uow is not None
    assert uow.committed is False

    # ---- verify data is NOT persisted ----
    cur = db_conn.cursor()
    try:
        cur.execute("SELECT 1 FROM enterprise WHERE id = %s", (ent.id,))
        row = cur.fetchone()
        assert row is None, "enterprise should NOT be persisted after UoW rollback"
    finally:
        cur.close()


def test_uow_committed_flag_after_success(db_conn):
    """UoW.committed is True after clean exit."""
    ent = _fresh_enterprise()
    with UnitOfWork(db_conn) as uow:
        uow.enterprises().create(ent)
    assert uow.committed is True


def test_uow_committed_flag_after_exception(db_conn):
    """UoW.committed is False after exception."""
    with pytest.raises(ValueError):
        with UnitOfWork(db_conn) as uow:
            raise ValueError("test")
    assert uow.committed is False


# ═══════════════════════════════════════════════════════════════════
# Migration runner tests
# ═══════════════════════════════════════════════════════════════════

# Known tables from 001_initial_schema.sql (19 domain tables + _migrations = 20)
_EXPECTED_TABLES = {
    "enterprise",
    "membership",
    "employee",
    "agent_template",
    "recruitment_order",
    "employee_prompt",
    "employee_skill_binding",
    "employee_knowledge_binding",
    "employee_memory_binding",
    "enterprise_connector",
    "employee_connector_binding",
    "conversation",
    "conversation_member",
    "team_run",
    "team_task",
    "scheduled_job",
    "runtime_binding",
    "run_event",
    "audit_event",
    "_migrations",
}


def test_migration_creates_all_expected_tables(db_conn):
    """After migrations, all expected core tables exist."""
    cur = db_conn.cursor()
    try:
        cur.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'public' ORDER BY table_name"
        )
        actual = {row[0] for row in cur.fetchall()}
        missing = _EXPECTED_TABLES - actual
        assert not missing, f"Missing tables: {missing}"
        extra = actual - _EXPECTED_TABLES
        # Allow extra tables (e.g. psycopg2 test artifacts), just warn
        if extra:
            print(f"Note: extra tables found (not in expected set): {extra}")
    finally:
        cur.close()


def test_migration_runner_is_idempotent(db_conn):
    """Rerunning apply_migrations must not fail and must not duplicate records."""
    # Record current _migrations state
    cur = db_conn.cursor()
    try:
        cur.execute("SELECT COUNT(*) FROM _migrations")
        before = cur.fetchone()[0]
    finally:
        cur.close()

    # Rerun migrations
    apply_migrations(db_conn)

    cur = db_conn.cursor()
    try:
        cur.execute("SELECT COUNT(*) FROM _migrations")
        after = cur.fetchone()[0]
    finally:
        cur.close()

    assert after == before, (
        f"Idempotency violated: _migrations count changed from {before} to {after}"
    )


def test_migration_records_filename(db_conn):
    """Migration runner records the migration filename in _migrations."""
    assert is_applied(db_conn, "001_initial_schema.sql"), (
        "Expected 001_initial_schema.sql to be recorded in _migrations"
    )


# ═══════════════════════════════════════════════════════════════════
# Fresh-DB migration test (module-level fixture)
# ═══════════════════════════════════════════════════════════════════

_FRESH_DB_NAME = "aiteam_test_fresh"


@pytest.fixture(scope="module")
def fresh_db_conn():
    """Module-scoped connection to a dedicated empty database.

    Creates a separate database on the same PostgreSQL server so we can
    verify that migration from scratch creates every expected table.
    """
    # Connect to the default 'postgres' DB to issue CREATE DATABASE
    admin_conn = psycopg2.connect(
        host="127.0.0.1", port=5433,
        user="aiteam", password="aiteam_test",
        dbname="postgres",
    )
    admin_conn.autocommit = True
    admin_cur = admin_conn.cursor()
    try:
        admin_cur.execute(
            f"SELECT 1 FROM pg_database WHERE datname = %s",
            (_FRESH_DB_NAME,),
        )
        if admin_cur.fetchone():
            admin_cur.execute(
                f"SELECT pg_terminate_backend(pg_stat_activity.pid) "
                f"FROM pg_stat_activity "
                f"WHERE pg_stat_activity.datname = %s AND pid <> pg_backend_pid()",
                (_FRESH_DB_NAME,),
            )
            admin_cur.execute(f"DROP DATABASE {_FRESH_DB_NAME}")
        admin_cur.execute(f"CREATE DATABASE {_FRESH_DB_NAME}")
    finally:
        admin_cur.close()
        admin_conn.close()

    conn = psycopg2.connect(
        host="127.0.0.1", port=5433,
        user="aiteam", password="aiteam_test",
        dbname=_FRESH_DB_NAME,
    )
    conn.autocommit = True
    yield conn
    conn.close()

    # Teardown: drop the fresh DB
    admin_conn = psycopg2.connect(
        host="127.0.0.1", port=5433,
        user="aiteam", password="aiteam_test",
        dbname="postgres",
    )
    admin_conn.autocommit = True
    admin_cur = admin_conn.cursor()
    try:
        admin_cur.execute(
            f"SELECT pg_terminate_backend(pg_stat_activity.pid) "
            f"FROM pg_stat_activity "
            f"WHERE pg_stat_activity.datname = %s AND pid <> pg_backend_pid()",
            (_FRESH_DB_NAME,),
        )
        admin_cur.execute(f"DROP DATABASE {_FRESH_DB_NAME}")
    finally:
        admin_cur.close()
        admin_conn.close()


def test_migration_from_empty_db_creates_all_tables(fresh_db_conn):
    """Run apply_migrations on a truly empty database and verify all tables."""
    # Before: no tables
    cur = fresh_db_conn.cursor()
    try:
        cur.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'public'"
        )
        before = {row[0] for row in cur.fetchall()}
        assert not before, f"Expected empty DB but found tables: {before}"
    finally:
        cur.close()

    apply_migrations(fresh_db_conn)

    cur = fresh_db_conn.cursor()
    try:
        cur.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'public' ORDER BY table_name"
        )
        after = {row[0] for row in cur.fetchall()}
        missing = _EXPECTED_TABLES - after
        assert not missing, f"Missing tables after fresh migration: {missing}"
    finally:
        cur.close()


def test_fresh_migration_is_idempotent(fresh_db_conn):
    """Rerunning apply_migrations on a freshly-migrated DB is safe."""
    # First run
    apply_migrations(fresh_db_conn)

    cur = fresh_db_conn.cursor()
    try:
        cur.execute("SELECT COUNT(*) FROM _migrations")
        before = cur.fetchone()[0]
    finally:
        cur.close()

    # Second run
    apply_migrations(fresh_db_conn)

    cur = fresh_db_conn.cursor()
    try:
        cur.execute("SELECT COUNT(*) FROM _migrations")
        after = cur.fetchone()[0]
    finally:
        cur.close()

    assert after == before


# ═══════════════════════════════════════════════════════════════════
# Repository smoke path through UoW
# ═══════════════════════════════════════════════════════════════════

def test_enterprise_repo_smoke_through_uow(db_conn):
    """Create enterprise via UoW and verify with separate repo instance."""
    ent = _fresh_enterprise()

    with UnitOfWork(db_conn) as uow:
        repo = uow.enterprises()
        repo.create(ent)

    # Verify with separate repo (simulates Layer2 usage pattern)
    from team_panel.repositories.enterprise_repo import EnterpriseRepo
    cur = db_conn.cursor()
    try:
        repo2 = EnterpriseRepo(cur)
        loaded = repo2.get_by_id(ent.id)
        assert loaded is not None
        assert loaded.id == ent.id
        assert loaded.name == ent.name
        assert loaded.slug == ent.slug
        assert loaded.owner_user_id == ent.owner_user_id
        assert loaded.status == "active"
    finally:
        cur.close()


def test_multiple_repo_ops_single_transaction(db_conn):
    """Multiple repository operations within one UoW share the transaction."""
    ent = _fresh_enterprise(id="ent_multi", slug="ent-multi")

    with UnitOfWork(db_conn) as uow:
        uow.enterprises().create(ent)

        # Update via same repo
        repo = uow.enterprises()
        loaded = repo.get_by_id("ent_multi")
        assert loaded is not None
        loaded.name = "Updated Name"
        repo.update(loaded)

        # Verify within transaction
        reloaded = repo.get_by_id("ent_multi")
        assert reloaded is not None
        assert reloaded.name == "Updated Name"

    # Verify commit persisted correctly
    cur = db_conn.cursor()
    try:
        cur.execute("SELECT name FROM enterprise WHERE id = %s", ("ent_multi",))
        row = cur.fetchone()
        assert row is not None
        assert row[0] == "Updated Name"
    finally:
        cur.close()
