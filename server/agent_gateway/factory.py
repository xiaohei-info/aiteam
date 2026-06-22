"""Gateway 生产装配（06 §7.2/§7.3/§7.6）。

把 `runtime_selection` 装配成一个真实 `GatewayRunner`：按注册表选 Driver，按 Driver 声明的
`executor_family` 配对 Executor 协议族，注入子进程沙箱（§13 隔离）。

不静默切换：未知 runtime_selection 由 `get_driver` 显式报错。默认装配（Fake）仍在
agent_service/mainline/factory，本模块只负责"真实 runtime"路径。
"""

from __future__ import annotations

from shared.contracts.gateway import Executor

from .acp_executor import AcpClientExecutor
from .codex_executor import CodexAppServerExecutor
from .drivers import get_driver
from .executors import (
    JsonStreamCliExecutor,
    PlainCliExecutor,
)
from .runner import GatewayRunner
from .sandbox import SandboxPolicy

# 协议族 → Executor 类（06 §7.2）。Driver.executor_family 据此配对。
# acp → AcpClientExecutor（真 ACP 客户端，#184）；json_rpc_stdio → CodexAppServerExecutor
# （真 codex app-server 客户端，#185）；其余为一次性子进程流式执行器。
EXECUTOR_FAMILIES: dict[str, type[Executor]] = {
    "acp": AcpClientExecutor,
    "json_rpc_stdio": CodexAppServerExecutor,
    "json_stream_cli": JsonStreamCliExecutor,
    "plain_cli": PlainCliExecutor,
}


def build_executor(family: str, *, sandbox: SandboxPolicy | None = None) -> Executor:
    """按协议族实例化 Executor（注入沙箱）。未知族显式报错，不静默降级。"""
    executor_cls = EXECUTOR_FAMILIES.get(family)
    if executor_cls is None:
        raise ValueError(
            f"unknown executor_family: {family!r}; known: {sorted(EXECUTOR_FAMILIES)}"
        )
    return executor_cls(sandbox=sandbox)  # type: ignore[call-arg]


def build_runner(runtime_selection: str, *, sandbox: SandboxPolicy | None = None) -> GatewayRunner:
    """按 runtime_selection 装配真实 (Executor, Driver) → GatewayRunner。

    未知 runtime_selection 由 get_driver 抛 ValueError（§7.6 不静默切换）。
    """
    driver = get_driver(runtime_selection)
    family = getattr(driver, "executor_family", None)
    if not family:
        raise ValueError(f"driver {runtime_selection!r} declares no executor_family")
    executor = build_executor(family, sandbox=sandbox)
    return GatewayRunner(executor=executor, driver=driver)
