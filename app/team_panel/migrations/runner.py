"""Migration runner — reads migrations/ dir, tracks applied in _migrations table."""

from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parent


def ensure_migration_table(cur) -> None:
    """Create the _migrations bookkeeping table if it doesn't exist yet."""
    cur.execute(
        """CREATE TABLE IF NOT EXISTS _migrations (
            filename TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )"""
    )


def apply_migrations(conn, *, src_dir: Path | None = None) -> None:
    """Apply all .sql migration files that haven't been recorded yet.

    Parameters
    ----------
    conn:
        A psycopg2 connection.  autocommit will be temporarily enabled so
        that multi-statement SQL files can be executed in one call.
    src_dir:
        Optional override for the migration source directory (useful in tests).
    """
    source = src_dir or MIGRATIONS_DIR
    sql_files = sorted(source.glob("*.sql"))
    if not sql_files:
        return

    prev_autocommit = conn.autocommit
    conn.autocommit = True
    cur = conn.cursor()
    try:
        ensure_migration_table(cur)

        cur.execute("SELECT filename FROM _migrations")
        applied = {row[0] for row in cur.fetchall()}

        for f in sql_files:
            if f.name in applied:
                continue
            sql = f.read_text()
            cur.execute(sql)
            cur.execute(
                "INSERT INTO _migrations (filename) VALUES (%s)",
                (f.name,),
            )
    finally:
        cur.close()
        conn.autocommit = prev_autocommit


def is_applied(conn, filename: str) -> bool:
    """Return True if *filename* has already been recorded in _migrations."""
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT 1 FROM _migrations WHERE filename = %s",
            (filename,),
        )
        return cur.fetchone() is not None
    except Exception:
        return False
    finally:
        cur.close()
