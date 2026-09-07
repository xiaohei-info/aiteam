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
    docker.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f"printf '%s\\n' \"$*\" >> {docker_log.as_posix()!r}\n"
        "if [[ \"$*\" == *' config'* ]]; then\n"
        "  printf 'config\\n'\n"
        "  exit 0\n"
        "fi\n"
        "if [[ \"$1\" == compose && \"$*\" == *' ps --all'* ]]; then\n"
        "  printf 'aiteam-pg postgres Exited (1)\\n'\n"
        "  exit 0\n"
        "fi\n"
        "printf 'unexpected docker %s\\n' \"$*\" >&2\n"
        "exit 2\n",
        encoding="utf-8",
    )
    docker.chmod(docker.stat().st_mode | stat.S_IEXEC)

    wrapper = tmp_path / "probe.sh"
    wrapper.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f"DEPLOY_ROOT={deploy_root.as_posix()!r}\n"
        "ENV_TARGET=test\n"
        "BRANCH=main\n"
        "log() { printf 'LOG %s\\n' \"$*\"; }\n"
        "fail() { printf 'FAIL %s\\n' \"$*\" >&2; exit 1; }\n"
        + _function_source()
        + "\n"
        "start_release_dependency postgres PostgreSQL\n"
        "printf 'START_OK\\n'\n",
        encoding="utf-8",
    )
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IEXEC)
    env = os.environ | {"PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", "")}
    result = subprocess.run(
        ["bash", str(wrapper)],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
    )
    return result, ctl_log, docker_log


def test_dependency_start_failure_is_visible_and_fail_closed(tmp_path):
    result, ctl_log, docker_log = _run_start(
        tmp_path,
        ctl_rc=1,
        ctl_output=(
            "Error response from daemon: Conflict. The container name \"/aiteam-pg\" is already in use\n"
            "POSTGRES_PASSWORD=test-secret-value\n"
            "postgresql://aiteam:test-secret-value@localhost:5433/aiteam_v1"
        ),
    )
    combined = result.stdout + result.stderr
    assert result.returncode == 1
    assert "START_OK" not in result.stdout
    assert "PostgreSQL dependency is not available for backup/DDL" in result.stderr
    assert "container name \"/aiteam-pg\" is already in use" in combined
    assert "aiteam-pg postgres Exited (1)" in combined
    assert "dependency compose ps --all (names/status only)" in combined
    assert "test-secret-value" not in combined
    assert "POSTGRES_PASSWORD=<redacted>" in combined
    assert "postgresql://<redacted>" in combined
    assert ctl_log.read_text(encoding="utf-8").count("\n") == 1
    assert "start --env test --deploy docker --server postgres" in ctl_log.read_text(encoding="utf-8")
    docker_calls = docker_log.read_text(encoding="utf-8")
    assert docker_calls.count("\n") == 1
    assert "ps --all" in docker_calls
    assert "config" not in docker_calls
    assert "up -d" not in docker_calls


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
