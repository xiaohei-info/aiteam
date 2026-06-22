"""#173 验收：子进程沙箱（§13 隔离）。

工作目录隔离（每 run 独立 cwd、防 `../` 穿越）、环境脱敏（仅 allowlist 放行）、
凭据最小注入（extra_env）。
"""

import os
from pathlib import Path

from agent_gateway.sandbox import (
    DEFAULT_ENV_ALLOWLIST,
    SandboxPolicy,
    build_env,
    prepare_run_dir,
)


def test_prepare_run_dir_isolates_per_run(tmp_path):
    policy = SandboxPolicy(runs_root=str(tmp_path))
    d1 = prepare_run_dir(policy, "run_a")
    d2 = prepare_run_dir(policy, "run_b")
    assert d1 != d2
    assert Path(d1).is_dir() and Path(d2).is_dir()
    assert Path(d1).parent == tmp_path.resolve()


def test_prepare_run_dir_blocks_path_traversal(tmp_path):
    policy = SandboxPolicy(runs_root=str(tmp_path))
    d = prepare_run_dir(policy, "../../etc/evil")
    # 只取 basename，结果仍在 runs_root 之下，不穿越。
    assert Path(d).parent == tmp_path.resolve()
    assert Path(d).name == "evil"


def test_prepare_run_dir_idempotent(tmp_path):
    policy = SandboxPolicy(runs_root=str(tmp_path))
    assert prepare_run_dir(policy, "r") == prepare_run_dir(policy, "r")


def test_build_env_scrubs_to_allowlist(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("SECRET_LEAK", "do-not-pass")
    policy = SandboxPolicy(runs_root=str(tmp_path))
    env = build_env(policy)
    assert env.get("PATH") == "/usr/bin"   # allowlist 命中 → 放行
    assert "SECRET_LEAK" not in env        # 不在 allowlist → 脱敏剔除
    assert "PATH" in DEFAULT_ENV_ALLOWLIST


def test_build_env_injects_extra_env(tmp_path):
    policy = SandboxPolicy(runs_root=str(tmp_path), extra_env={"INJECTED": "yes"})
    assert build_env(policy)["INJECTED"] == "yes"


def test_build_env_only_passes_present_keys(tmp_path, monkeypatch):
    monkeypatch.delenv("TERM", raising=False)
    env = build_env(SandboxPolicy(runs_root=str(tmp_path)))
    assert "TERM" not in env  # allowlist 里但 os.environ 没有 → 不凭空造
