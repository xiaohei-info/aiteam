"""Layer1 test fixtures — provides shared PostgreSQL test infrastructure.

AI Team pytest expects `psycopg2` to be importable before conftest loading.
At runtime this fixture tries PostgreSQL on 127.0.0.1:5433 first, then falls
back to a disposable Docker postgres container to preserve a single bootstrap
path for layer1/layer2 tests.
"""

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


def _cleanup_stale_ephemeral_postgres() -> None:
    result = subprocess.run(
        [
            "docker",
            "ps",
            "-aq",
            "--filter",
            "name=^aiteam-l1-uow-",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    container_ids = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not container_ids:
        return
    subprocess.run(
        ["docker", "rm", "-f", *container_ids],
        check=False,
        capture_output=True,
        text=True,
    )


def _reuse_running_ephemeral_postgres() -> tuple[str, int] | None:
    result = subprocess.run(
        [
            "docker",
            "ps",
            "--format",
            "{{.Names}}",
            "--filter",
            "name=^aiteam-l1-uow-",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    container_names = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    for container_name in container_names:
        try:
            port = _discover_published_port(container_name)
        except Exception:
            continue
        if _port_open(_DB_HOST, port):
            return container_name, port
    return None


def _discover_published_port(container_name: str) -> int:
    result = subprocess.run(
        ["docker", "port", container_name, "5432/tcp"],
        check=True,
        capture_output=True,
        text=True,
    )
    binding = result.stdout.strip().splitlines()[0]
    host_port = binding.rsplit(":", 1)[-1]
    return int(host_port)


def _start_ephemeral_postgres() -> tuple[str, int]:
    if shutil.which("docker") is None:
        pytest.skip(
            "PostgreSQL test backend unavailable: docker not installed "
            "and no local PG on 5433"
        )

    _cleanup_stale_ephemeral_postgres()
    container_name = f"aiteam-l1-uow-{uuid.uuid4().hex[:8]}"
    subprocess.run(
        [
            "docker", "run", "--rm", "-d", "--name", container_name,
            "-e", f"POSTGRES_USER={_DB_USER}",
            "-e", f"POSTGRES_PASSWORD={_DB_PASSWORD}",
            "-e", f"POSTGRES_DB={_DB_NAME}",
            "-p", f"{_DB_HOST}::5432",
            "postgres:16-alpine",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return container_name, _discover_published_port(container_name)


def _connect_db(port: int):
    return psycopg2.connect(
        host=_DB_HOST,
        port=port,
        user=_DB_USER,
        password=_DB_PASSWORD,
        dbname=_DB_NAME,
        connect_timeout=2,
    )


def _connect_admin_db(port: int, dbname: str = "postgres"):
    return psycopg2.connect(
        host=_DB_HOST,
        port=port,
        user=_DB_USER,
        password=_DB_PASSWORD,
        dbname=dbname,
        connect_timeout=2,
    )


def _create_session_database(port: int, dbname: str) -> None:
    admin = _connect_admin_db(port)
    admin.autocommit = True
    try:
        with admin.cursor() as cur:
            cur.execute(f'CREATE DATABASE "{dbname}"')
    finally:
        admin.close()


def _drop_session_database(port: int, dbname: str) -> None:
    admin = _connect_admin_db(port)
    admin.autocommit = True
    try:
        with admin.cursor() as cur:
            cur.execute(
                "SELECT pg_terminate_backend(pid) "
                "FROM pg_stat_activity "
                "WHERE datname = %s AND pid <> pg_backend_pid()",
                (dbname,),
            )
            cur.execute(f'DROP DATABASE IF EXISTS "{dbname}"')
    finally:
        admin.close()


@pytest.fixture(scope="session")
def db_conn():
    """Session-scoped PostgreSQL connection for Layer1 repository tests.

    Tries local PG on 5433 first; falls back to a disposable Docker container.
    Applies all pending migrations before yielding the connection.
    """
    container_name = None
    owns_container = False
    session_db_name = f"{_DB_NAME}_{uuid.uuid4().hex[:8]}"
    port = _EXISTING_DB_PORT
    if not _port_open(_DB_HOST, port):
        reused = _reuse_running_ephemeral_postgres()
        if reused is not None:
            container_name, port = reused
        else:
            container_name, port = _start_ephemeral_postgres()
            owns_container = True

    last_error = None
    for _ in range(80):
        try:
            # Require two successful probes so we don't race the container's
            # entrypoint restart window during initial bootstrap.
            probe = _connect_db(port)
            probe.autocommit = True
            with probe.cursor() as cur:
                cur.execute("SELECT 1")
            probe.close()

            _time.sleep(0.5)

            admin_probe = _connect_admin_db(port)
            admin_probe.autocommit = True
            with admin_probe.cursor() as cur:
                cur.execute("SELECT 1")
            admin_probe.close()

            _create_session_database(port, session_db_name)
            conn = psycopg2.connect(
                host=_DB_HOST,
                port=port,
                user=_DB_USER,
                password=_DB_PASSWORD,
                dbname=session_db_name,
                connect_timeout=2,
            )
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
            apply_migrations(conn)
            break
        except (psycopg2.OperationalError, psycopg2.InterfaceError) as exc:
            last_error = exc
            _time.sleep(0.5)
        except psycopg2.Error as exc:
            last_error = exc
            _time.sleep(0.5)
    else:
        if owns_container and container_name is not None:
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
        try:
            _drop_session_database(port, session_db_name)
        except psycopg2.Error:
            pass
        if owns_container and container_name is not None:
            subprocess.run(
                ["docker", "rm", "-f", container_name],
                check=False, capture_output=True, text=True,
            )


@pytest.fixture(autouse=True)
def clean_tables(db_conn):
    """Clean mutable tables before each repository-style test."""
    cur = db_conn.cursor()
    try:
        # Order matters due to FK constraints
        cur.execute("TRUNCATE TABLE run_event CASCADE")
        cur.execute("TRUNCATE TABLE audit_event CASCADE")
        cur.execute("TRUNCATE TABLE runtime_binding CASCADE")
        cur.execute("TRUNCATE TABLE conversation_read_state CASCADE")
        cur.execute("TRUNCATE TABLE workbench_employee_preference CASCADE")
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
