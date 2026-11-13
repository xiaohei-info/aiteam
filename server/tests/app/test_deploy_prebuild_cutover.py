"""先构建后切换 + 在线迁移（deploy/ci/run.sh）的整脚本模拟。

真实的 git（本地 origin），其余全部是桩：systemctl、docker、curl、corepack、node、pnpm、
ctl.sh 与 .venv 里的 python。不接触 taiyi，也不读取任何真实密钥。
"""
from __future__ import annotations

import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
RUN_SH = ROOT / "deploy/ci/run.sh"
CONTRACT_MARKER = "-- deploy-compat: contract"

STUBS = {
    "systemctl": r"""#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "${STUB_TMP}/calls.log"
case "$1" in
  is-active) [[ -f "${STUB_TMP}/active" ]] ;;
  stop) rm -f "${STUB_TMP}/active" ;;
  restart) : > "${STUB_TMP}/active" ;;
  *) exit 0 ;;
esac
""",
    "docker": r"""#!/usr/bin/env bash
case "$1" in
  ps) exit 0 ;;
  inspect) printf 'healthy\n' ;;
  exec) if [[ "$*" == *psql* ]]; then printf '1\n'; fi ;;
esac
exit 0
""",
    "curl": r"""#!/usr/bin/env bash
if [[ "$*" == */healthz* ]]; then
  if [[ -f "${STUB_TMP}/bad_sha" && "$(cat "${STUB_TMP}/bad_sha")" == "$(git -C "${STUB_ROOT}" rev-parse HEAD)" ]]; then
    exit 22
  fi
  exit 0
fi
if [[ "$*" == */api/status* ]]; then printf '{"success": true}\n'; exit 0; fi
printf 'text/html; charset=utf-8'
""",
    "corepack": "#!/usr/bin/env bash\nexit 0\n",
    "node": "#!/usr/bin/env bash\nprintf '11.4.0\\n'\n",
}
PNPM = r"""#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then printf '11.4.0\n'; exit 0; fi
where="live"; [[ "${PWD}" == "${STUB_ROOT}-stage"* ]] && where="stage"
printf 'pnpm %s %s %s\n' "${where}" "$(basename "${PWD}")" "$*" >> "${STUB_TMP}/calls.log"
case "$1" in
  install)
    if [[ -n "${PNPM_FAIL_DIR:-}" && "${PWD}" == *"${PNPM_FAIL_DIR}" && "$*" != *--offline* ]]; then exit 1; fi
    mkdir -p node_modules ;;
  build)
    for tier in operation manager agent; do
      mkdir -p "${tier}/dist"
      git rev-parse HEAD > "${tier}/dist/index.html"
    done ;;
esac
exit 0
"""
FAKE_PYTHON = r"""#!/usr/bin/env python3
import os
import sys
from pathlib import Path

venv = Path(__file__).resolve().parents[1]
log = venv.parents[1] / "calls.log"
def record(line):
    with log.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")
argv = sys.argv[1:]
if argv[:1] == ["-c"] and argv[1].startswith("import shared.db"):
    raise SystemExit(1 if (venv / "import_fail").exists() else 0)
if argv[:1] == ["-c"]:
    exec(argv[1], {"__name__": "__main__"})
    raise SystemExit(0)
if argv[:2] == ["-m", "pip"]:
    record("pip " + argv[2] + (" offline" if os.environ.get("PIP_NO_INDEX") == "1" else ""))
    raise SystemExit(0)
if argv == ["-"]:
    leaked = sorted(k for k in os.environ if k not in {"PATH", "PYTHONPATH", "AITEAM_MIGRATION_ENV_FILE", "PGOPTIONS", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"})
    record("migrate %s pgoptions=%r leaked=%s" % (os.environ["PYTHONPATH"], os.environ.get("PGOPTIONS", ""), leaked))
    raise SystemExit(1 if (venv / "migration_fail").exists() else 0)
raise SystemExit(2)
"""


def _write_exec(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", *args],
        cwd=cwd, check=True, capture_output=True, text=True,
    ).stdout.strip()


class Deploy:
    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.origin = tmp / "origin.git"
        self.work = tmp / "work"
        self.live = tmp / "live"
        self.stage = tmp / "live-stage"
        self.bin = tmp / "bin"
        # run.sh 先检查 PATH 上有 pnpm，再把 corepack 缓存里的固定版本放到 PATH 最前；
        # 两处都要有桩，测试不能依赖宿主机装了什么。
        for name, text in (STUBS | {"pnpm": PNPM}).items():
            _write_exec(self.bin / name, text)
        _write_exec(tmp / "home/.cache/node/corepack/v1/pnpm/11.4.0/bin/pnpm.mjs", PNPM)
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.origin)], check=True)
        subprocess.run(["git", "clone", "-q", str(self.origin), str(self.work)], check=True, capture_output=True)
        files = {
            ".gitignore": "node_modules/\ndist/\n.venv/\n.env.*\n.state/\nlogs/\n",
            "web/package.json": '{"packageManager": "pnpm@11.4.0"}\n',
            "server/agent_service/package.json": "{}\n",
            "server/solution_authoring_worker/package.json": "{}\n",
            "server/requirements.txt": "PyYAML==6.0.3\n",
            "server/operation_service/migrations/0001_init.sql": "CREATE TABLE IF NOT EXISTS a (id int);\n",
            "deploy/ci/aiteam-v1.service": "[Service]\nWorkingDirectory=@DEPLOY_ROOT@\nExecStart=x --env @ENV_TARGET@\n",
        }
        for rel, text in files.items():
            (self.work / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.work / rel).write_text(text, encoding="utf-8")
        _write_exec(self.work / "scripts/ctl.sh", "#!/usr/bin/env bash\nexit 0\n")
        self.first = self.commit("first release")
        subprocess.run(["git", "clone", "-q", str(self.origin), str(self.live)], check=True, capture_output=True)
        _write_exec(self.live / ".venv/bin/python", FAKE_PYTHON.replace("#!/usr/bin/env python3", f"#!{sys.executable}", 1))
        (self.live / ".env.test").write_text("APP_RW_PASSWORD=local-test-value\nLEAK_PROBE=1\n", encoding="utf-8")
        for tier in ("operation", "manager", "agent"):
            (self.live / "web" / tier / "dist").mkdir(parents=True)
            (self.live / "web" / tier / "dist/index.html").write_text(self.first + "\n", encoding="utf-8")
        (tmp / "active").write_text("", encoding="utf-8")

    def commit(self, message: str, files: dict[str, str] | None = None) -> str:
        for rel, text in (files or {}).items():
            (self.work / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.work / rel).write_text(text, encoding="utf-8")
        _git(self.work, "add", "-A")
        _git(self.work, "commit", "-q", "-m", message)
        _git(self.work, "push", "-q", "origin", "HEAD:main")
        return _git(self.work, "rev-parse", "HEAD")

    def run(self, **extra: str) -> subprocess.CompletedProcess[str]:
        env = {
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "HOME": str(self.tmp / "home"),
            "STUB_TMP": str(self.tmp),
            "STUB_ROOT": str(self.live.resolve()),
            "DEPLOY_ROOT": str(self.live),
            "DEPLOY_SYSTEMD_UNIT_DIR": str(self.tmp / "units"),
            "DEPLOY_HEALTHZ_WARMUP_SECONDS": "0",
            "DEPLOY_HEALTHZ_RETRY_SECONDS": "0",
            "GIT_CONFIG_NOSYSTEM": "1",
        } | extra
        return subprocess.run(
            ["bash", str(RUN_SH), "--branch", "main", "--env", "test"],
            cwd=self.live, env=env, capture_output=True, text=True, timeout=120,
        )

    def calls(self) -> list[str]:
        log = self.tmp / "calls.log"
        return log.read_text(encoding="utf-8").splitlines() if log.exists() else []

    def head(self) -> str:
        return _git(self.live, "rev-parse", "HEAD")

    def served(self) -> str:
        return (self.live / "web/operation/dist/index.html").read_text(encoding="utf-8").strip()

    def running(self) -> bool:
        return (self.tmp / "active").exists()


def _index(calls: list[str], prefix: str) -> int:
    hits = [i for i, line in enumerate(calls) if line.startswith(prefix)]
    assert hits, f"{prefix!r} not in {calls}"
    return hits[0]


@pytest.fixture
def deploy(tmp_path: Path) -> Deploy:
    return Deploy(tmp_path)


def test_expand_only_release_is_built_and_migrated_before_the_stop(deploy: Deploy):
    target = deploy.commit("second", {
        "server/operation_service/migrations/0002_more.sql": "ALTER TABLE a ADD COLUMN IF NOT EXISTS b int;\n",
        "server/requirements.txt": "PyYAML==6.0.3\npypdf==7.0.1\n",
    })
    result = deploy.run()
    assert result.returncode == 0, result.stdout + result.stderr
    calls = deploy.calls()
    stop = _index(calls, "systemctl stop")
    before, after = calls[:stop], calls[stop:]
    # 联网安装、构建、wheels、迁移都发生在停应用之前，而且都在旁路目录。
    for pkg in ("agent_service", "solution_authoring_worker", "web"):
        assert f"pnpm stage {pkg} install --frozen-lockfile" in before
    assert "pnpm stage web build" in before
    assert "pip wheel" in before
    assert not any(line.startswith("pnpm live") for line in before)
    migrations = [line for line in calls if line.startswith("migrate ")]
    assert len(migrations) == 1 and migrations[0] in before
    assert f"{deploy.stage.resolve()}/server" in migrations[0]
    assert "lock_timeout=5000" in migrations[0]
    assert migrations[0].endswith("leaked=[]")
    # 停机窗口内只有离线动作。
    assert "pnpm live agent_service install --frozen-lockfile --offline" in after
    assert "pnpm live solution_authoring_worker install --frozen-lockfile --offline" in after
    assert "pip install offline" in after
    assert not any(line.startswith("pnpm live") and "--offline" not in line for line in after)
    assert _index(calls, "systemctl restart") > stop
    assert deploy.head() == target and deploy.served() == target and deploy.running()
    assert "LEAK_PROBE" not in result.stdout + result.stderr


def test_prepare_failure_leaves_the_running_release_untouched(deploy: Deploy):
    deploy.commit("second", {"server/agent_service/package.json": '{"x": 1}\n'})
    result = deploy.run(PNPM_FAIL_DIR="solution_authoring_worker")
    assert result.returncode == 1
    assert "running release untouched" in result.stderr
    calls = deploy.calls()
    assert not any(line.startswith(("systemctl stop", "systemctl restart", "migrate ")) for line in calls)
    assert deploy.head() == deploy.first and deploy.served() == deploy.first and deploy.running()


def test_online_migration_failure_aborts_before_the_stop(deploy: Deploy):
    deploy.commit("second", {"server/operation_service/migrations/0002_more.sql": "SELECT 1;\n"})
    (deploy.live / ".venv/migration_fail").write_text("", encoding="utf-8")
    result = deploy.run()
    assert result.returncode == 1
    assert "online migration failed before cutover" in result.stderr
    assert not any(line.startswith("systemctl stop") for line in deploy.calls())
    assert deploy.head() == deploy.first and deploy.running()
    assert not list(deploy.live.glob(".aiteam-migration-env.*"))


def test_unhealthy_new_release_rolls_back_to_the_previous_one(deploy: Deploy):
    target = deploy.commit("second", {"server/agent_service/package.json": '{"x": 1}\n'})
    (deploy.tmp / "bad_sha").write_text(target, encoding="utf-8")
    result = deploy.run()
    assert result.returncode == 1, "a rolled-back deploy must still fail"
    assert "ROLLBACK complete" in result.stdout
    calls = deploy.calls()
    assert sum(line.startswith("systemctl restart") for line in calls) == 2
    assert deploy.head() == deploy.first and deploy.served() == deploy.first and deploy.running()


def test_contract_migration_runs_in_the_stop_window_and_blocks_rollback(deploy: Deploy):
    target = deploy.commit("second", {
        "server/operation_service/migrations/0002_drop.sql": f"{CONTRACT_MARKER}\nALTER TABLE a DROP COLUMN IF EXISTS b;\n",
    })
    (deploy.tmp / "bad_sha").write_text(target, encoding="utf-8")
    result = deploy.run()
    assert result.returncode == 1
    calls = deploy.calls()
    migrations = [line for line in calls if line.startswith("migrate ")]
    assert len(migrations) == 1
    assert calls.index(migrations[0]) > _index(calls, "systemctl stop")
    assert f"{deploy.live.resolve()}/server" in migrations[0] and "lock_timeout" not in migrations[0]
    assert "no rollback: this release applied a contract migration" in result.stdout
    assert "ROLLBACK to previous release" not in result.stdout
    assert deploy.head() == target


def test_migration_failure_in_the_stop_window_is_not_rolled_back(deploy: Deploy):
    deploy.commit("second", {"server/operation_service/migrations/0002_more.sql": "SELECT 1;\n"})
    (deploy.live / ".venv/import_fail").write_text("", encoding="utf-8")
    (deploy.live / ".venv/migration_fail").write_text("", encoding="utf-8")
    result = deploy.run()
    assert result.returncode == 1
    assert "migrating during the cutover" in result.stdout
    assert "application writers remain stopped" in result.stderr
    assert "ROLLBACK to previous release" not in result.stdout
    assert not deploy.running()


def test_stopped_application_is_deployed_without_online_migration(deploy: Deploy):
    target = deploy.commit("second", {"server/agent_service/package.json": '{"x": 1}\n'})
    (deploy.tmp / "active").unlink()
    result = deploy.run()
    assert result.returncode == 0, result.stdout + result.stderr
    calls = deploy.calls()
    assert not any(line.startswith("systemctl stop") for line in calls)
    assert _index(calls, "migrate ") > _index(calls, "pnpm live agent_service install")
    assert deploy.head() == target and deploy.running()
