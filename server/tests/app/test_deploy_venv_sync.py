"""Persistent TEST venv requirements sync (deploy/ci/run.sh).

Uses a fake .venv interpreter only. Never contacts taiyi or reads real secrets.
"""
from __future__ import annotations

import hashlib
import os
import stat
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
RUN_SH = ROOT / "deploy/ci/run.sh"
START = "# --- persistent venv requirements sync ---\n"
END = "# --- end persistent venv requirements sync ---\n"
FAKE_PYTHON = r"""#!/usr/bin/env python3
import os
import sys
from pathlib import Path

log = Path(os.environ["PIP_LOG"])
if len(sys.argv) >= 2 and sys.argv[1] == "-c":
    exec(sys.argv[2], {"__name__": "__main__"})
    raise SystemExit(0)
if sys.argv[1:3] == ["-m", "pip"]:
    if os.environ.get("PIP_FAIL") == "1":
        log.write_text("fail " + " ".join(sys.argv[1:]) + "\n", encoding="utf-8")
        raise SystemExit(1)
    log.write_text(" ".join(sys.argv[1:]) + "\n", encoding="utf-8")
    raise SystemExit(0)
raise SystemExit(2)
"""


def _function_source() -> str:
    text = RUN_SH.read_text(encoding="utf-8")
    start = text.index(START)
    end = text.index(END, start) + len(END)
    return text[start:end]


def _run_sync(tmp_path: Path, *, marker: str | None, pip_fail: bool = False) -> subprocess.CompletedProcess[str]:
    deploy_root = tmp_path / "deploy-root"
    venv_bin = deploy_root / ".venv" / "bin"
    venv_bin.mkdir(parents=True)
    req = deploy_root / "server" / "requirements.txt"
    req.parent.mkdir(parents=True)
    req.write_text("PyYAML==6.0.3\n", encoding="utf-8")
    python = venv_bin / "python"
    python.write_text(FAKE_PYTHON, encoding="utf-8")
    python.chmod(python.stat().st_mode | stat.S_IEXEC)
    if marker is not None:
        (deploy_root / ".venv" / ".aiteam-requirements.sha256").write_text(marker + "\n", encoding="utf-8")
    pip_log = tmp_path / "pip.log"
    wrapper = tmp_path / "probe.sh"
    wrapper.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f"DEPLOY_ROOT={deploy_root.as_posix()!r}\n"
        "ENV_TARGET=test\n"
        "BRANCH=main\n"
        "log() { printf '%s\\n' \"$*\"; }\n"
        "fail() { printf 'FAIL %s\\n' \"$*\" >&2; exit 1; }\n"
        + _function_source()
        + "\n"
        "sync_persistent_venv_requirements \"${DEPLOY_ROOT}/.venv/bin/python\"\n"
        "printf 'SYNC_OK\\n'\n",
        encoding="utf-8",
    )
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IEXEC)
    env = os.environ | {"PIP_LOG": str(pip_log), "PIP_FAIL": "1" if pip_fail else "0"}
    return subprocess.run(
        ["bash", str(wrapper)],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
    ), pip_log, deploy_root, hashlib.sha256(req.read_bytes()).hexdigest()


def test_missing_marker_installs_and_writes_hash(tmp_path):
    result, pip_log, deploy_root, digest = _run_sync(tmp_path, marker=None)
    assert result.returncode == 0, result.stderr
    assert "SYNC_OK" in result.stdout
    assert pip_log.read_text(encoding="utf-8").strip() == "-m pip install --requirement " + str(
        deploy_root / "server" / "requirements.txt"
    )
    assert (deploy_root / ".venv" / ".aiteam-requirements.sha256").read_text(encoding="utf-8").strip() == digest
    assert "PyYAML==6.0.3" not in result.stdout
    assert "SECRET" not in result.stdout + result.stderr


def test_current_marker_skips_pip(tmp_path):
    digest = hashlib.sha256(b"PyYAML==6.0.3\n").hexdigest()
    result, pip_log, deploy_root, actual = _run_sync(tmp_path, marker=digest)
    assert actual == digest
    assert result.returncode == 0, result.stderr
    assert "SYNC_OK" in result.stdout
    assert not pip_log.exists()
    assert (deploy_root / ".venv" / ".aiteam-requirements.sha256").read_text(encoding="utf-8").strip() == digest


def test_stale_marker_reinstalls(tmp_path):
    result, pip_log, deploy_root, digest = _run_sync(tmp_path, marker="0" * 64)
    assert result.returncode == 0, result.stderr
    assert pip_log.exists()
    assert "pip install --requirement" in pip_log.read_text(encoding="utf-8")
    assert (deploy_root / ".venv" / ".aiteam-requirements.sha256").read_text(encoding="utf-8").strip() == digest


def test_pip_failure_is_fail_closed_before_start(tmp_path):
    result, pip_log, deploy_root, _digest = _run_sync(tmp_path, marker=None, pip_fail=True)
    assert result.returncode == 1
    assert "SYNC_OK" not in result.stdout
    assert "pip install --requirement server/requirements.txt failed" in result.stderr
    assert "application writers remain stopped" in result.stderr
    assert not (deploy_root / ".venv" / ".aiteam-requirements.sha256").exists()
    assert pip_log.read_text(encoding="utf-8").startswith("fail ")
