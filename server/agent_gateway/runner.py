"""Gateway runner 骨架（A0 / 06 §7.2 接入层）。

把"选定 Driver + Executor + 一个 AgentRunRequest"编排成一次 run：驱动执行、归一事件回流、
返回终态。**只编排运行时接入，不定义/不碰业务对象**（06 铁律 + CLAUDE/AGENTS §8）。

A0 用 fake runtime（C0.4）跑通；真实 Driver/Executor 由 Track G 接入，runner 不变。
"""

from __future__ import annotations

from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.gateway import (
    Driver,
    EventSink,
    Executor,
    RunResult,
    RuntimeCapability,
)
from shared.contracts.runspec import AgentRunRequest


class GatewayRunner:
    """单 run 接入编排器。绑定一个协议族 Executor + 一个 runtime Driver。"""

    def __init__(self, *, executor: Executor, driver: Driver):
        self._executor = executor
        self._driver = driver

    def capabilities(self) -> RuntimeCapability:
        """透出底层 Driver 的能力声明（供上层做能力对齐/降级，06 §7.5.4）。"""
        return self._driver.capabilities()

    async def run(self, request: AgentRunRequest, on_event: EventSink) -> RunResult:
        """驱动一次 run，归一事件经 on_event 回流，返回终态。"""
        return await self._executor.execute(request, self._driver, on_event)

    async def run_and_collect(
        self, request: AgentRunRequest
    ) -> tuple[RunResult, list[AgentRuntimeEvent]]:
        """便捷模式：内部缓冲归一事件并随终态返回（便于 timeline 映射前查看/测试）。"""
        events: list[AgentRuntimeEvent] = []

        async def _sink(ev: AgentRuntimeEvent) -> None:
            events.append(ev)

        result = await self._executor.execute(request, self._driver, _sink)
        return result, events

    async def cancel(self, run_id: str) -> None:
        """取消运行中的 run（透传给 Executor 做进程/连接清理）。"""
        await self._executor.cancel(run_id)
