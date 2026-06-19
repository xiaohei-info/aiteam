"""首批 Driver 集（06 §7.3）。

每个 runtime 一个 Driver、绑定一个 Executor 协议族（§7.2）。Driver 是唯一翻译点：
RunSpec → 启动命令（B 类 flag/协议）+ raw 事件 → AgentRuntimeEvent（§7.5.4 规则 2）。
A 类能力（知识/记忆/连接器/降级技能）统一经 RunSpec.mcp_config 注入（§7.5.2）。

`runtime_selection` → Driver 的查表入口（§7.6）；找不到即明确报错，**不静默切换**。
"""

from __future__ import annotations

from shared.contracts.gateway import Driver

from .claude_code import ClaudeCodeJsonStreamDriver
from .codex import CodexJsonRpcDriver
from .hermes import HermesAcpDriver
from .openclaw import OpenClawJsonStreamDriver
from .opencode import OpenCodeJsonStreamDriver

# runtime 标识 → Driver 类（与各 Driver 的 runtime_name 对齐）。
DRIVER_REGISTRY: dict[str, type[Driver]] = {
    HermesAcpDriver.runtime_name: HermesAcpDriver,
    CodexJsonRpcDriver.runtime_name: CodexJsonRpcDriver,
    ClaudeCodeJsonStreamDriver.runtime_name: ClaudeCodeJsonStreamDriver,
    OpenCodeJsonStreamDriver.runtime_name: OpenCodeJsonStreamDriver,
    OpenClawJsonStreamDriver.runtime_name: OpenClawJsonStreamDriver,
}


def get_driver(runtime_selection: str) -> Driver:
    """按 runtime_selection 实例化对应 Driver（§7.6：不静默切换，找不到显式报错）。"""
    driver_cls = DRIVER_REGISTRY.get(runtime_selection)
    if driver_cls is None:
        raise ValueError(
            f"unknown runtime_selection: {runtime_selection!r}; "
            f"known runtimes: {sorted(DRIVER_REGISTRY)}"
        )
    return driver_cls()


__all__ = [
    "ClaudeCodeJsonStreamDriver",
    "CodexJsonRpcDriver",
    "HermesAcpDriver",
    "OpenClawJsonStreamDriver",
    "OpenCodeJsonStreamDriver",
    "DRIVER_REGISTRY",
    "get_driver",
]
