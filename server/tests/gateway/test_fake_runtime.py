"""fake runtime 验收（C0.4 / 10 Phase 1）：产出事件最小集并以 completed 终态收尾。"""

import asyncio

from agent_gateway.fake_runtime import FakeDriver, FakeExecutor
from shared.contracts.gateway import Executor
from shared.contracts.runspec import AgentRunRequest, RunSpec


def _run(request, executor):
    events = []

    async def sink(ev):
        events.append(ev)

    result = asyncio.run(executor.execute(request, FakeDriver(), sink))
    return events, result


def _req(run_id="r1"):
    return AgentRunRequest(run_id=run_id, tenant_id="t1", run_spec=RunSpec(model="default"))


def test_fake_executor_is_executor():
    assert isinstance(FakeExecutor(), Executor)


def test_emits_minimal_event_set_and_completes():
    events, result = _run(_req(), FakeExecutor())
    types = [e.type for e in events]
    assert types[0] == "status"
    assert "text_delta" in types and "reasoning_delta" in types
    assert "tool_call_started" in types and "tool_call_completed" in types
    assert "usage" in types
    assert types[-1] == "completed"
    assert result.success is True
    assert result.usage == {"input_tokens": 10, "output_tokens": 5}


def test_events_carry_run_id_and_session():
    events, result = _run(_req("run-xyz"), FakeExecutor())
    assert all(e.run_id == "run-xyz" for e in events)
    assert result.session_id == "fake-session"


def test_cancel_short_circuits():
    executor = FakeExecutor()
    asyncio.run(executor.cancel("r1"))
    events, result = _run(_req("r1"), executor)
    assert result.success is False
    assert result.error == "cancelled"
    assert events[-1].type == "cancelled"


def test_driver_capabilities_and_command():
    d = FakeDriver()
    cap = d.capabilities()
    assert cap.runtime == "fake" and cap.supports_mcp is True
    assert d.build_command(RunSpec(model="m1")) == ["fake-runtime", "--model", "m1"]
