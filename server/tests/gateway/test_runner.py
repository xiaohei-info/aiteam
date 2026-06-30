"""Gateway runner 骨架验收（A0 / 06 §7.2）。

runner 是网关接入层：拿一个 AgentRunRequest + 选定的 Driver/Executor，驱动一次 run，
把归一事件回流给 EventSink，返回终态。**只编排，不懂业务对象**（06 铁律）。

本测试用 fake runtime（C0.4 范例）验证编排正确：事件最小集出齐、completed 收尾、
session/usage 透传、取消短路。
"""

import asyncio

from agent_gateway.drivers.fake_runtime import FakeDriver, FakeExecutor
from agent_gateway.runner import GatewayRunner
from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.runspec import AgentRunRequest, RunSpec


def _req(run_id="run-1"):
    return AgentRunRequest(run_id=run_id, tenant_id="t-1", run_spec=RunSpec(model="default"))


def _runner():
    return GatewayRunner(executor=FakeExecutor(), driver=FakeDriver())


def test_run_emits_minimal_events_and_completes():
    runner = _runner()
    collected: list[AgentRuntimeEvent] = []

    async def sink(ev):
        collected.append(ev)

    result = asyncio.run(runner.run(_req(), sink))

    types = [e.type for e in collected]
    assert types[0] == "status"
    assert types[-1] == "completed"
    assert {"text_delta", "reasoning_delta", "tool_call_started", "usage"} <= set(types)
    assert result.success is True
    assert result.session_id == "fake-session"
    assert result.usage == {"input_tokens": 10, "output_tokens": 5}


def test_runner_collects_events_when_no_sink():
    """便捷收集模式：不传 sink 时 runner 内部缓冲归一事件，便于 timeline 映射前查看。"""
    runner = _runner()
    result, events = asyncio.run(runner.run_and_collect(_req()))
    assert result.success is True
    assert [e.type for e in events][-1] == "completed"
    assert all(e.run_id == "run-1" for e in events)


def test_runner_cancel_short_circuits():
    runner = _runner()

    async def scenario():
        await runner.cancel("run-1")
        return await runner.run_and_collect(_req("run-1"))

    result, events = asyncio.run(scenario())
    assert result.success is False
    assert result.error == "cancelled"
    assert events[-1].type == "cancelled"


def test_runner_exposes_driver_capabilities():
    runner = _runner()
    cap = runner.capabilities()
    assert cap.runtime == "fake"
    assert cap.supports_mcp is True
