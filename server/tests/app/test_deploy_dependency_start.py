"""Visible, fail-closed TEST dependency start (deploy/ci/run.sh).

Stubs ctl.sh and docker only. Never contacts taiyi or reads real secrets.
"""
from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
RUN_SH = ROOT / "deploy/ci/run.sh"
START = "# --- dependency start diagnostics ---\n"
END = "# --- end dependency start diagnostics ---\n"
PG_NAME_CONFLICT = (
    'Error response from daemon: Conflict. The container name "/aiteam-pg" '
    "is already in use by container \"4d679ba5295824e4fc8f8ec581713e31\"."
)
MATCHING_META = "/aiteam-pg|pgvector/pgvector:pg16|exited|aiteam_pg_data_test"
MATCHING_ENV = (
    "POSTGRES_USER=aiteam\n"
    "POSTGRES_PASSWORD=inspect-secret-value\n"
    "POSTGRES_DB=aiteam_v1\n"
)
MATCHING_PORTS = '{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"5433"}]}'
MATCHING_NETWORK_MODE = "aiteam_default"
DOCKER_STUB = r"""#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${DOCKER_LOG}"
if [[ "$1" == inspect ]]; then
  if [[ "${ALLOW_INSPECT}" != 1 ]]; then
    printf 'unexpected docker %s\n' "$*" >&2
    exit 2
  fi
  if [[ "${@: -1}" != aiteam-pg ]]; then
    printf 'unexpected inspect target %s\n' "$*" >&2
    exit 2
  fi
  if [[ "${INSPECT_RC}" -ne 0 ]]; then
    exit "${INSPECT_RC}"
  fi
  if [[ "$*" == *'.HostConfig.NetworkMode'* ]]; then
    printf '%s' "${INSPECT_NETWORK_MODE}"
    exit 0
  fi
  if [[ "$*" == *'.Config.Env'* ]]; then
    printf '%s' "${INSPECT_ENV}"
    exit 0
  fi
  if [[ "$*" == *'.HostConfig.PortBindings'* ]]; then
    printf '%s' "${INSPECT_PORTS}"
    exit 0
  fi
  printf '%s\n' "${INSPECT_META}"
  exit 0
fi
if [[ "$1" == start ]]; then
  if [[ "${ALLOW_INSPECT}" != 1 || "${2:-}" != aiteam-pg ]]; then
    printf 'unexpected docker %s\n' "$*" >&2
    exit 2
  fi
  if [[ -n "${START_OUTPUT}" ]]; then
    printf '%s\n' "${START_OUTPUT}"
  fi
  exit "${START_RC}"
fi
if [[ "$1" == compose && "$*" == *' ps --all'* ]]; then
  printf 'aiteam-pg postgres Exited (1)\n'
  exit 0
fi
if [[ "$*" == *' config'* ]]; then
  printf 'config\n'
  exit 0
fi
printf 'unexpected docker %s\n' "$*" >&2
exit 2
"""


def _function_source() -> str:
    text = RUN_SH.read_text(encoding="utf-8")
    start = text.index(START)
    end = text.index(END, start) + len(END)
    return text[start:end]


def _run_start(
    tmp_path: Path,
    *,
    ctl_rc: int,
    ctl_output: str,
    allow_inspect: bool = False,
    inspect_meta: str = MATCHING_META,
    inspect_env: str = MATCHING_ENV,
    inspect_rc: int = 0,
    start_rc: int = 0,
    start_output: str = "aiteam-pg",
    inspect_ports: str = MATCHING_PORTS,
    inspect_network_mode: str = MATCHING_NETWORK_MODE,
    postgres_volume: str | None = None,
    postgres_image: str | None = None,
) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
    deploy_root = tmp_path / "deploy-root"
    scripts = deploy_root / "scripts"
    compose_dir = deploy_root / "deploy" / "docker"
    bin_dir = tmp_path / "bin"
    scripts.mkdir(parents=True)
    compose_dir.mkdir(parents=True)
    bin_dir.mkdir(parents=True)
    (compose_dir / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")

    ctl_log = tmp_path / "ctl.log"
    docker_log = tmp_path / "docker.log"
    ctl = scripts / "ctl.sh"
    ctl.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f"printf '%s\\n' \"$*\" >> {ctl_log.as_posix()!r}\n"
        "cat <<'CTLOUT'\n"
        f"{ctl_output.rstrip()}\n"
        "CTLOUT\n"
        f"exit {ctl_rc}\n",
        encoding="utf-8",
    )
    ctl.chmod(ctl.stat().st_mode | stat.S_IEXEC)

    docker = bin_dir / "docker"
    docker.write_text(DOCKER_STUB, encoding="utf-8")
    docker.chmod(docker.stat().st_mode | stat.S_IEXEC)

    extra_env = ""
    if postgres_volume is not None:
        extra_env += f"POSTGRES_VOLUME={postgres_volume!r}\n"
    if postgres_image is not None:
        extra_env += f"POSTGRES_IMAGE={postgres_image!r}\n"
    wrapper = tmp_path / "probe.sh"
    wrapper.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f"DEPLOY_ROOT={deploy_root.as_posix()!r}\n"
        "ENV_TARGET=test\n"
        "BRANCH=main\n"
        + extra_env
        + "log() { printf 'LOG %s\\n' \"$*\"; }\n"
        "fail() { printf 'FAIL %s\\n' \"$*\" >&2; exit 1; }\n"
        + _function_source()
        + "\n"
        "start_release_dependency postgres PostgreSQL\n"
        "printf 'START_OK\\n'\n",
        encoding="utf-8",
    )
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IEXEC)
    env = os.environ | {
        "PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", ""),
        "DOCKER_LOG": str(docker_log),
        "ALLOW_INSPECT": "1" if allow_inspect else "0",
        "INSPECT_META": inspect_meta,
        "INSPECT_ENV": inspect_env,
        "INSPECT_PORTS": inspect_ports,
        "INSPECT_NETWORK_MODE": inspect_network_mode,
        "INSPECT_RC": str(inspect_rc),
        "START_RC": str(start_rc),
        "START_OUTPUT": start_output,
        "POSTGRES_DB": "aiteam_v1",
        "MANAGER_DB_NAME": "aiteam_v1",
        "POSTGRES_SUPER_USER": "aiteam",
    }
    result = subprocess.run(
        ["bash", str(wrapper)],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
    )
    return result, ctl_log, docker_log


def _docker_calls(docker_log: Path) -> str:
    if not docker_log.exists():
        return ""
    return docker_log.read_text(encoding="utf-8")


def test_dependency_start_failure_is_visible_and_fail_closed(tmp_path):
    result, ctl_log, docker_log = _run_start(
        tmp_path,
        ctl_rc=1,
        ctl_output=(
            "failed to start postgres: connection refused\n"
            "POSTGRES_PASSWORD=test-secret-value\n"
            "postgresql://aiteam:test-secret-value@localhost:5433/aiteam_v1"
        ),
    )
    combined = result.stdout + result.stderr
    assert result.returncode == 1
    assert "START_OK" not in result.stdout
    assert "PostgreSQL dependency is not available for backup/DDL" in result.stderr
    assert "failed to start postgres: connection refused" in combined
    assert "aiteam-pg postgres Exited (1)" in combined
    assert "dependency compose ps --all (names/status only)" in combined
    assert "test-secret-value" not in combined
    assert "POSTGRES_PASSWORD=<redacted>" in combined
    assert "postgresql://<redacted>" in combined
    assert "reusing verified" not in combined
    assert "starting verified" not in combined
    assert ctl_log.read_text(encoding="utf-8").count("\n") == 1
    assert "start --env test --deploy docker --server postgres" in ctl_log.read_text(encoding="utf-8")
    docker_calls = _docker_calls(docker_log)
    assert docker_calls.count("\n") == 1
    assert "ps --all" in docker_calls
    assert "inspect" not in docker_calls
    assert "start aiteam-pg" not in docker_calls
    assert "config" not in docker_calls
    assert "up -d" not in docker_calls
    assert " rm " not in f" {docker_calls} "


def test_dependency_start_success_prints_ctl_output_without_compose_ps(tmp_path):
    result, ctl_log, docker_log = _run_start(
        tmp_path,
        ctl_rc=0,
        ctl_output="[ctl] Started postgres (docker)",
    )
    assert result.returncode == 0, result.stderr
    assert "START_OK" in result.stdout
    assert "[ctl] Started postgres (docker)" in result.stdout
    assert "FAIL " not in result.stderr
    assert "compose ps" not in result.stdout
    assert not docker_log.exists()
    assert "start --env test --deploy docker --server postgres" in ctl_log.read_text(encoding="utf-8")


def test_name_conflict_starts_matching_stopped_postgres_container(tmp_path):
    result, ctl_log, docker_log = _run_start(
        tmp_path,
        ctl_rc=1,
        ctl_output=(
            f"{PG_NAME_CONFLICT}\n"
            "POSTGRES_PASSWORD=ctl-secret-value\n"
            "postgresql://aiteam:ctl-secret-value@localhost:5433/aiteam_v1"
        ),
        allow_inspect=True,
        inspect_meta=MATCHING_META,
        inspect_env=MATCHING_ENV,
    )
    combined = result.stdout + result.stderr
    assert result.returncode == 0, combined
    assert "START_OK" in result.stdout
    assert "started verified existing PostgreSQL container aiteam-pg" in combined
    assert "container name \"/aiteam-pg\" is already in use" in combined
    assert "compose ps" not in combined
    assert "FAIL " not in result.stderr
    assert "ctl-secret-value" not in combined
    assert "inspect-secret-value" not in combined
    assert "POSTGRES_PASSWORD=inspect-secret-value" not in combined
    assert "POSTGRES_PASSWORD=<redacted>" in combined
    assert ctl_log.read_text(encoding="utf-8").count("\n") == 1
    docker_calls = _docker_calls(docker_log)
    assert docker_calls.count("inspect ") == 4
    assert docker_calls.count("start aiteam-pg") == 1
    assert "ps --all" not in docker_calls
    assert "up -d" not in docker_calls
    assert " rm " not in f" {docker_calls} "
    assert "volume" not in docker_calls


def test_name_conflict_accepts_matching_running_postgres_container(tmp_path):
    result, _ctl_log, docker_log = _run_start(
        tmp_path,
        ctl_rc=1,
        ctl_output=PG_NAME_CONFLICT,
        allow_inspect=True,
        inspect_meta="/aiteam-pg|pgvector/pgvector:pg16|running|aiteam_pg_data_test",
        inspect_env=MATCHING_ENV,
    )
    combined = result.stdout + result.stderr
    assert result.returncode == 0, combined
    assert "START_OK" in result.stdout
    assert "reusing verified running PostgreSQL container aiteam-pg" in combined
    assert "started verified" not in combined
    assert "compose ps" not in combined
    assert "inspect-secret-value" not in combined
    docker_calls = _docker_calls(docker_log)
    assert docker_calls.count("inspect ") == 4
    assert "start aiteam-pg" not in docker_calls
    assert "ps --all" not in docker_calls
    assert " rm " not in f" {docker_calls} "


def test_name_conflict_rejects_publicly_bound_postgres_container(tmp_path):
    result, _ctl_log, docker_log = _run_start(
        tmp_path,
        ctl_rc=1,
        ctl_output=PG_NAME_CONFLICT,
        allow_inspect=True,
        inspect_ports='{"5432/tcp":[{"HostIp":"0.0.0.0","HostPort":"5433"}]}',
    )
    combined = result.stdout + result.stderr
    assert result.returncode == 1
    assert "existing PostgreSQL host binding is not loopback-only" in combined
    assert "PostgreSQL dependency is not available for backup/DDL" in combined
    assert "start aiteam-pg" not in _docker_calls(docker_log)


def test_name_conflict_rejects_host_network_postgres_container(tmp_path):
    result, _ctl_log, docker_log = _run_start(
        tmp_path,
        ctl_rc=1,
        ctl_output=PG_NAME_CONFLICT,
        allow_inspect=True,
        inspect_network_mode="host",
    )
    combined = result.stdout + result.stderr
    assert result.returncode == 1
    assert "network mode is not isolated" in combined
    assert "PostgreSQL dependency is not available for backup/DDL" in combined
    assert "start aiteam-pg" not in _docker_calls(docker_log)


def test_name_conflict_rejects_mismatched_postgres_container(tmp_path):
    result, _ctl_log, docker_log = _run_start(
        tmp_path,
        ctl_rc=1,
        ctl_output=PG_NAME_CONFLICT,
        allow_inspect=True,
        inspect_meta="/aiteam-pg|postgres:16|exited|aiteam_pg_data_test",
        inspect_env=MATCHING_ENV,
    )
    combined = result.stdout + result.stderr
    assert result.returncode == 1
    assert "START_OK" not in result.stdout
    assert "existing PostgreSQL image mismatch" in combined
    assert "leaving it untouched" in combined
    assert "PostgreSQL dependency is not available for backup/DDL" in result.stderr
    assert "aiteam-pg postgres Exited (1)" in combined
    assert "inspect-secret-value" not in combined
    docker_calls = _docker_calls(docker_log)
    assert "inspect " in docker_calls
    assert "start aiteam-pg" not in docker_calls
    assert "ps --all" in docker_calls
    assert " rm " not in f" {docker_calls} "


def test_name_conflict_rejects_docker_start_failure(tmp_path):
    result, _ctl_log, docker_log = _run_start(
        tmp_path,
        ctl_rc=1,
        ctl_output=PG_NAME_CONFLICT,
        allow_inspect=True,
        inspect_meta=MATCHING_META,
        inspect_env=MATCHING_ENV,
        start_rc=1,
        start_output="POSTGRES_PASSWORD=start-secret-value\nfailed to start container",
    )
    combined = result.stdout + result.stderr
    assert result.returncode == 1
    assert "START_OK" not in result.stdout
    assert "docker start aiteam-pg failed" in combined
    assert "PostgreSQL dependency is not available for backup/DDL" in result.stderr
    assert "start-secret-value" not in combined
    assert "inspect-secret-value" not in combined
    assert "POSTGRES_PASSWORD=<redacted>" in combined
    docker_calls = _docker_calls(docker_log)
    assert docker_calls.count("start aiteam-pg") == 1
    assert "ps --all" in docker_calls
    assert " rm " not in f" {docker_calls} "
