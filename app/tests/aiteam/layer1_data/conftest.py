"""Layer1 test fixtures — provides fresh PostgreSQL test DB for each test.

Reuses existing local-PG-or-ephemeral-docker strategy from existing
layer1 test files to avoid introducing a conflicting bootstrap path.
"""

import os
import shutil
import socket
import subprocess
import uuid
import time as _time

import psycopg2
import pytest
from team_panel.migrations.runner import apply_migrations

_DB_HOST = "127.0.0.1"
_EXISTING_DB_PORT = 5433
_EPHEMERAL_DB_PORT = 55433
_DB_USER = "aiteam"
_DB_PASSWORD = "aiteam_test"
_DB_NAME = "aiteam_test"


def _port_open(host: str, port: int) -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.5)
        try:
            sock.connect((host, port))
            return True
        except OSError:
            return False


def _start_ephemeral_postgres() -> tuple:
    if shutil.which("docker") is None:
        pytest.skip(
            "PostgreSQL test backend unavailable: docker not installed "
            "and no local PG on 5433"
        )

    container_name = f"aiteam-l1-uow-{uuid.uuid4().hex[:8]}"
    subprocess.run(
        [
            "docker", "run", "--rm", "-d", "--name", container_name,
            "-e", f"POSTGRES_USER={_DB_USER}",
            "-e", f"POSTGRES_PASSWORD={_DB_PASSWORD}",
            "-e", f"POSTGRES_DB={_DB_NAME}",
            "-p", f"{_EPHEMERAL_DB_PORT}:5432",
            "postgres:16-alpine",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return container_name, _EPHEMERAL_DB_PORT


@pytest.fixture(scope="session")
def db_conn():
    """Session-scoped PostgreSQL connection for Layer1 repository tests.

    Tries local PG on 5433 first; falls back to a disposable Docker container.
    Applies all pending migrations before yielding the connection.
    """
    container_name = None
    port = _EXISTING_DB_PORT
    if not _port_open(_DB_HOST, port):
        container_name, port = _start_ephemeral_postgres()

    last_error = None
    for _ in range(40):
        try:
            conn = psycopg2.connect(
                host=_DB_HOST, port=port,
                user=_DB_USER, password=_DB_PASSWORD, dbname=_DB_NAME,
            )
            conn.autocommit = True
            apply_migrations(conn)
            break
        except psycopg2.OperationalError as exc:
            last_error = exc
            _time.sleep(0.5)
    else:
        if container_name is not None:
            subprocess.run(
                ["docker", "rm", "-f", container_name],
                check=False, capture_output=True, text=True,
            )
        raise AssertionError(
            f"PostgreSQL test backend did not become ready: {last_error}"
        )

    try:
        yield conn
    finally:
        conn.close()
        if container_name is not None:
            subprocess.run(
                ["docker", "rm", "-f", container_name],
                check=False, capture_output=True, text=True,
            )


@pytest.fixture
def clean_tables(db_conn):
    """Clean mutable tables before each repository test (autouse)."""
    cur = db_conn.cursor()
    try:
        # Order matters due to FK constraints
        cur.execute("TRUNCATE TABLE run_event CASCADE")
        cur.execute("TRUNCATE TABLE audit_event CASCADE")
        cur.execute("TRUNCATE TABLE runtime_binding CASCADE")
        cur.execute("TRUNCATE TABLE scheduled_job CASCADE")
        cur.execute("TRUNCATE TABLE team_task CASCADE")
        cur.execute("TRUNCATE TABLE team_run CASCADE")
        cur.execute("TRUNCATE TABLE conversation_message CASCADE")
        cur.execute("TRUNCATE TABLE conversation_member CASCADE")
        cur.execute("TRUNCATE TABLE conversation CASCADE")
        cur.execute("TRUNCATE TABLE employee_connector_binding CASCADE")
        cur.execute("TRUNCATE TABLE memory_review_decision CASCADE")
        cur.execute("TRUNCATE TABLE memory_item CASCADE")
        cur.execute("TRUNCATE TABLE enterprise_skill_install CASCADE")
        cur.execute("TRUNCATE TABLE enterprise_connector CASCADE")
        cur.execute("TRUNCATE TABLE employee_memory_binding CASCADE")
        cur.execute("TRUNCATE TABLE employee_knowledge_binding CASCADE")
        cur.execute("TRUNCATE TABLE employee_skill_binding CASCADE")
        cur.execute("TRUNCATE TABLE employee_prompt CASCADE")
        cur.execute("TRUNCATE TABLE recharge_order CASCADE")
        cur.execute("TRUNCATE TABLE enterprise_billing_account CASCADE")
        cur.execute("TRUNCATE TABLE admin_invite CASCADE")
        cur.execute("TRUNCATE TABLE enterprise_settings CASCADE")
        cur.execute("TRUNCATE TABLE recruitment_order CASCADE")
        cur.execute("TRUNCATE TABLE solution_template_binding CASCADE")
        cur.execute("TRUNCATE TABLE industry_solution CASCADE")
        cur.execute("TRUNCATE TABLE agent_template CASCADE")
        cur.execute("TRUNCATE TABLE employee_org_assignment CASCADE")
        cur.execute("TRUNCATE TABLE department CASCADE")
        cur.execute("TRUNCATE TABLE employee CASCADE")
        cur.execute("TRUNCATE TABLE membership CASCADE")
        cur.execute("TRUNCATE TABLE enterprise CASCADE")
    finally:
        cur.close()
