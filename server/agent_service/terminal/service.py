"""Terminal 命令执行服务（issue #415）。

职责：
- 把一条 bash 命令装配成 Gateway 的一次 terminal run（runtime_selection=terminal），
  经 TerminalDriver/TerminalExecutor 执行；
- 归一事件（command_started/command_output/completed/error/cancelled）经 on_event 回调回放；
- 隔离注入（§13）：复用 agent_gateway 的 SandboxPolicy，每 run 独立工作目录 + 脱敏 env。

本服务是 agent_gateway executor 的北向编排，**不**定义业务对象（企业/员工/权限/账单），
符合 Gateway 铁律（CLAUDE/AGENTS §8 / 06）。
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable

from agent_gateway.runner import GatewayRunner
from agent_gateway.sandbox import SandboxPolicy
from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.runspec import AgentRunRequest, RunSpec

# on_event 回放类型别名（与 gateway.EventSink 同形）。
_EventCallback = Callable[[AgentRuntimeEvent], Awaitable[None]]


def _new_run_id() -> str:
    return f"term_{uuid.uuid4().hex[:12]}"


class TerminalService:
    """单租户（用户端本地）命令执行编排器。

    用户端单用户本地库，无 tenant 路由；tenant_id 固定 "local"。
    """

    def __init__(self, runner: GatewayRunner) -> None:
        self._runner = runner

    @property
    def runner(self) -> GatewayRunner:
        """底层 runner（供装配层注入沙箱 / 能力查询）。"""
        return self._runner

    async def execute(
        self,
        command: str,
        on_event: _EventCallback,
        *,
        timeout_seconds: float |  None = None,
        workdir: str | None = None,
        env: dict | None = None,
    ) -> dict:
        """执行一条命令。

        归一事件经 on_event 同步回放（调用方推给 SSE/前端）。返回终态摘要：
        { "success": bool, "exit_code": int|None, "error": str|None }。
        """
        run_id = _new_run_id()
        request = AgentRunRequest(
            run_id=run_id,
            tenant_id="local",
            run_spec=RunSpec(
                custom_args=[command],
                timeout_seconds=timeout_seconds,
                cancellation_policy="graceful",
            ),
        )
        result = await self._runner.run(request, on_event)
        return {
            "success": result.success,
            "exit_code": self._exit_code_from(result),
            "error": result.error,
            "session_id": result.session_id,
            "usage": result.usage,
        }

    async def cancel(self, run_id: str) -> None:
        """取消运行中的 terminal run。"""
        await self._runner.cancel(run_id)

    @staticmethod
    def _exit_code_from(result) -> int | None:
        """从 usage 中取 exit_code（Executor 在 completed/error 事件 payload 中附带）。"""
        usage = result.usage or {}
        code = usage.get("exit_code")
        return int(code) if isinstance(code, (int, float)) else None


def build_terminal_service(
    *,
    sandbox: SandboxPolicy | None = None,
) -> TerminalService:
    """按 terminal runtime 装配 runner + 注入沙箱（§13 隔离）。"""
    from agent_gateway.factory import build_runner

    runner = build_runner("terminal", sandbox=sandbox)
    return TerminalService(runner=runner)


__all__ = ["TerminalService", "build_terminal_service"]
