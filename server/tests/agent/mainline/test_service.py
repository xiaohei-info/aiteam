"""A1.3 验收：主链服务编排（核心 parity）。

最小主链：建会话 -> 发消息 -> 起 run（fake runtime）-> 事件归一落 timeline -> 增量拉取。
parity 对照（与 MVP run_journal 口径）：
- cursor 单调（MVP per-run seq -> v1 per-conversation cursor）；增量按 cursor 拉取。
- 终态：fake completed -> 产品 run_succeeded + Run 持久态 COMPLETED（MVP done->completed）。
- 展示态全程不落 Run/Conversation 主状态（D6）。
"""

import asyncio

import pytest

from agent_service.mainline.factory import build_mainline_service
from agent_service.mainline.models import MessageRole, RunStatus, TaskStatus
from shared.contracts.enums import ConversationState


def _svc():
    return build_mainline_service()


def test_minimal_mainline_to_timeline_parity():
    svc = _svc()
    conv = svc.create_conversation(title="hello")
    assert conv.state is ConversationState.ACTIVE
    svc.add_message(conv.id, role=MessageRole.USER, content="hi")

    run = asyncio.run(svc.start_run(conv.id))

    # Run 终态落库：fake completed -> COMPLETED（parity MVP done->completed）。
    assert run.status is RunStatus.COMPLETED
    assert run.session_id == "fake-session"
    assert run.usage == {"input_tokens": 10, "output_tokens": 5}

    # timeline 增量：全量从 cursor 0。
    events = svc.read_timeline(conv.id, 0)
    types = [e.type for e in events]
    assert types[0] == "status"
    assert "message_delta" in types and "reasoning_delta" in types
    assert "tool_call_started" in types and "usage" in types
    assert types[-1] == "run_succeeded"  # 终态映射

    # cursor 严格单调（parity MVP seq 单调）。
    cursors = [e.cursor for e in events]
    assert cursors == list(range(1, len(events) + 1))

    # 增量拉取：after=中段。
    tail = svc.read_timeline(conv.id, cursors[2])
    assert [e.cursor for e in tail] == cursors[3:]

    # 前端只见 BusinessTimelineEvent：事件无 runtime 原生类型名。
    runtime_native = {"text_delta", "completed", "cancelled"}
    assert not (set(types) & runtime_native)


def test_display_state_never_written_to_persistent_state():
    """D6：展示态不落主状态。run 结束后 Conversation 仍是主状态枚举，Run 是终态枚举。"""
    svc = _svc()
    conv = svc.create_conversation()
    run = asyncio.run(svc.start_run(conv.id))
    # Conversation 主状态仍是固定枚举（未被 streaming/resolved 污染）。
    assert svc.get_conversation(conv.id).state in set(ConversationState)
    # Run 状态是终态枚举（非展示态）。
    assert run.status in set(RunStatus)


def test_task_lifecycle_follows_run():
    svc = _svc()
    conv = svc.create_conversation()
    task = svc.create_task(conv.id, title="job")
    assert task.status is TaskStatus.PENDING
    asyncio.run(svc.start_run(conv.id, task_id=task.id))
    assert svc.list_tasks(conv.id)[0].status is TaskStatus.DONE


def test_cancelled_run_maps_to_cancelled_terminal():
    """parity MVP cancel->interrupted-by-user -> v1 CANCELLED + run_cancelled。

    用一个总是短路为 cancelled 的 executor 驱动，验证终态收尾到 RunStatus.CANCELLED 且
    timeline 末事件是 run_cancelled。
    """
    from agent_gateway.fake_runtime import FakeDriver
    from shared.contracts.events import AgentRuntimeEvent
    from shared.contracts.gateway import Executor, RunResult

    class _AlwaysCancelExecutor(Executor):
        async def execute(self, request, driver, on_event):
            await on_event(AgentRuntimeEvent(
                event_id="e1", run_id=request.run_id, seq=1, type="status",
                source="fake", timestamp="2026-06-19T00:00:00Z", payload={}))
            await on_event(AgentRuntimeEvent(
                event_id="e2", run_id=request.run_id, seq=2, type="cancelled",
                source="fake", timestamp="2026-06-19T00:00:00Z", payload={}))
            return RunResult(run_id=request.run_id, success=False, error="cancelled")

        async def cancel(self, run_id):
            return None

    svc = build_mainline_service(executor=_AlwaysCancelExecutor(), driver=FakeDriver())
    conv = svc.create_conversation()
    task = svc.create_task(conv.id, title="job")
    run = asyncio.run(svc.start_run(conv.id, task_id=task.id))
    assert run.status is RunStatus.CANCELLED
    assert svc.read_timeline(conv.id, 0)[-1].type == "run_cancelled"
    assert svc.list_tasks(conv.id)[0].status is TaskStatus.CANCELLED


def test_missing_conversation_raises():
    from shared.errors import NotFound
    svc = _svc()
    with pytest.raises(NotFound):
        svc.add_message("nope", role=MessageRole.USER, content="x")
    with pytest.raises(NotFound):
        asyncio.run(svc.start_run("nope"))
