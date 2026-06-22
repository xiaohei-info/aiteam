"""Runtime Worker 子进程沙箱（CLAUDE/AGENTS §13 硬约束）。

真实 runtime 经子进程拉起时必须：**工作目录隔离**（每 run 独立 cwd）、**环境脱敏**
（只放行 allowlist，不把控制面/无关 env 整体泄漏给 runtime）、**凭据最小注入**（extra_env
作为最小注入接缝；provider 凭据按 provider_ref 解析后经此注入，不内联——本卡只留接缝）。

不写 runtime 原生 profile（D16）；run 作用域产物（工作目录/临时 MCP 配置）随 run 隔离。
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

# 默认放行的环境变量：仅 runtime 进程正常运行所需的中立项；其余（含密钥、控制面配置）
# 一律不传给子进程。需要的凭据走 SandboxPolicy.extra_env 显式最小注入。
DEFAULT_ENV_ALLOWLIST: tuple[str, ...] = (
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "USER",
    "SHELL",
    "TERM",
)


@dataclass(frozen=True)
class SandboxPolicy:
    """单端沙箱策略。runs_root 下按 run_id 建隔离工作目录；env 经 allowlist 脱敏 + extra_env 注入。"""

    runs_root: str
    env_allowlist: tuple[str, ...] = DEFAULT_ENV_ALLOWLIST
    extra_env: Mapping[str, str] = field(default_factory=dict)


def prepare_run_dir(policy: SandboxPolicy, run_id: str) -> str:
    """为本 run 建（必要时创建）隔离工作目录，返回绝对路径。

    run_id 取 basename 防止 `../` 越权穿越到 runs_root 之外。
    """
    safe = os.path.basename(run_id) or "run"
    path = Path(policy.runs_root).expanduser().resolve() / safe
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


def build_env(policy: SandboxPolicy) -> dict[str, str]:
    """构造脱敏后的子进程环境：allowlist 命中的 os.environ + extra_env（最小注入）。"""
    env = {k: os.environ[k] for k in policy.env_allowlist if k in os.environ}
    env.update(policy.extra_env)
    return env
