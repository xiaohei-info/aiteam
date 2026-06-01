"""Minimal migration runner — for test infrastructure only.

Loads SQL migration files from app/team_panel/migrations/ and applies them
against a given database connection.
"""
from pathlib import Path
from typing import Any


_MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


def run_migrations(conn: Any, *, through: str = "001") -> None:
    """Apply all migration files up to and including *through*.

    ``conn`` must be a DBAPI-compatible connection with autocommit enabled.
    Supports both connection objects that expose ``execute`` directly and the
    more common cursor-based interface used by psycopg2.
    """
    files = sorted(_MIGRATIONS_DIR.glob("*.sql"))
    if not files:
        raise FileNotFoundError(f"No migration files found in {_MIGRATIONS_DIR}")

    cursor = None if hasattr(conn, "execute") else conn.cursor()
    try:
        for migration_file in files:
            sql = migration_file.read_text()
            if cursor is not None:
                cursor.execute(sql)
            else:
                conn.execute(sql)
            if migration_file.name.startswith(through):
                break
    finally:
        if cursor is not None:
            cursor.close()
