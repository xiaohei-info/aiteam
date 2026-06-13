"""Database connection helper — PostgreSQL via psycopg2."""

import logging
import os
import threading

import psycopg2

logger = logging.getLogger(__name__)

DEFAULT_TEST_DATABASE_URL = "postgresql://aiteam:aiteam_test@127.0.0.1:5433/aiteam_test"

# Apply pending migrations exactly once per process, on the first real DB
# connection (the app does not otherwise run migrations on boot). Guarded so the
# work happens a single time even under concurrent first requests.
_migration_lock = threading.Lock()
_migrations_done = False


def _auto_migrate_enabled() -> bool:
    # Default ON. Tests manage their own schema via fixtures, so skip there.
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return False
    return os.environ.get("AITEAM_AUTO_MIGRATE", "1").strip().lower() in ("1", "true", "yes", "on")


def _ensure_migrations(conn) -> None:
    """Idempotently apply Team Panel migrations on the first connection of the
    process. The runner tracks applied files in ``_migrations`` so this is safe
    to call repeatedly. On failure it does not mark done (a later connection
    retries) and re-raises so the problem is visible rather than running on a
    half-migrated schema."""
    global _migrations_done
    if _migrations_done or not _auto_migrate_enabled():
        return
    with _migration_lock:
        if _migrations_done:
            return
        from ..migrations.runner import apply_migrations
        apply_migrations(conn)
        _migrations_done = True
        logger.info("[team-panel] startup migrations applied")


def get_database_url() -> str:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise ValueError("DATABASE_URL is required for Team Panel database connections")
    return database_url


def create_connection(database_url: str | None = None) -> psycopg2.extensions.connection:
    url = database_url or get_database_url()
    conn = psycopg2.connect(url)
    conn.autocommit = False
    _ensure_migrations(conn)
    return conn


def create_test_connection() -> psycopg2.extensions.connection:
    test_url = os.environ.get(
        "TEST_DATABASE_URL",
        DEFAULT_TEST_DATABASE_URL,
    )
    conn = psycopg2.connect(test_url)
    conn.autocommit = False
    return conn
