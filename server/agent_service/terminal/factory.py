"""用户端 Terminal 服务装配（issue #415）。

把 Gateway 的 terminal runner 装配成 TerminalService，注入子进程沙箱（§13 隔离）。
runs_root 未配置时使用临时目录（dev/测试默认）。
"""

from __future__ import annotations

import os
import tempfile

from agent_gateway.sandbox import SandboxPolicy

from .service import TerminalService
from .service import build_terminal_service as _build_service


def build_terminal_service(
    *,
    runs_root: str | None = None,
    env_passthrough: tuple[str, ...] = (),
) -> TerminalService:
    """按配置装配 TerminalService。

    runs_root 优先 AGENT_TERMINAL_RUNS_ROOT 环境变量，其次 agent runs_root，其次临时目录。
    env_passthrough 仅在生产注入 provider 凭据变量名（D8），默认空。
    """
    root = runs_root or os.getenv("AGENT_TERMINAL_RUNS_ROOT")
    if root is None:
        settings_root = os.getenv("AGENT_RUNS_ROOT")
        root = settings_root or os.path.join(tempfile.gettempdir(), "aiteam-terminal-runs")
    extra_env = {k: os.environ[k] for k in env_passthrough if k in os.environ}
    sandbox = SandboxPolicy(runs_root=root, extra_env=extra_env)
    return _build_service(sandbox=sandbox)


__all__ = ["build_terminal_service"]
