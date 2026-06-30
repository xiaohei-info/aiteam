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


def test_start_run_forwards_conversation_messages_to_runtime():
    """端到端接线：start_run 必须把会话历史组装成 input_messages 喂给 runtime，
    否则真实 runtime 收到空 prompt（此前的端到端缺口）。"""
    from agent_gateway.fake_runtime import FakeDriver
    from shared.contracts.gateway import Executor, RunResult

    captured: dict = {}

    class _CapturingExecutor(Executor):
        async def execute(self, request, driver, on_event):
            captured["input_messages"] = request.input_messages
            return RunResult(run_id=request.run_id, success=True)

        async def cancel(self, run_id):
            return None

    svc = build_mainline_service(executor=_CapturingExecutor(), driver=FakeDriver())
    conv = svc.create_conversation()
    svc.add_message(conv.id, role=MessageRole.USER, content="第一句")
    svc.add_message(conv.id, role=MessageRole.EMPLOYEE, content="专家回复")
    svc.add_message(conv.id, role=MessageRole.USER, content="再问一句")

    asyncio.run(svc.start_run(conv.id))

    assert captured["input_messages"] == [
        {"role": "user", "content": "第一句"},
        {"role": "assistant", "content": "专家回复"},
        {"role": "user", "content": "再问一句"},
    ]


def test_start_run_uses_call_tenant_for_runtime_request_and_usage_recorder():
    """Authenticated Agent runs must report usage under the login tenant, not process default local."""
    from agent_gateway.fake_runtime import FakeDriver
    from shared.contracts.gateway import Executor, RunResult

    captured: dict = {}
    usage_records: list[tuple[str, str]] = []

    class _CapturingExecutor(Executor):
        async def execute(self, request, driver, on_event):
            captured["tenant_id"] = request.tenant_id
            return RunResult(
                run_id=request.run_id,
                success=True,
                usage={"input_tokens": 1, "output_tokens": 2},
            )

        async def cancel(self, run_id):
            return None

    def _record(tenant_id, run_id, run_status, usage, error):
        usage_records.append((tenant_id, run_id))

    svc = build_mainline_service(
        executor=_CapturingExecutor(),
        driver=FakeDriver(),
        usage_recorder=_record,
    )
    conv = svc.create_conversation()

    run = asyncio.run(svc.start_run(conv.id, tenant_id="tenant-from-login"))

    assert captured["tenant_id"] == "tenant-from-login"
    assert usage_records == [("tenant-from-login", run.id)]


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


def _terminal_executor(*, runtime_terminal: str, result: "RunResult") -> "Executor":
    """造一个发指定终态事件的 executor：先发 status，再发 runtime 终态事件，回给定 RunResult。

    用于回归 #64：Run 终态由 timeline 终态事件反查派生（单一真相源），不再靠
    result.error 字符串硬匹配——即使 runtime 回非标准 error 串，Run 终态也随 timeline 一致。
    """
    from agent_gateway.fake_runtime import FakeDriver  # noqa: F401  仅示意，实际调用方传入
    from shared.contracts.events import AgentRuntimeEvent
    from shared.contracts.gateway import Executor

    class _ScriptedExecutor(Executor):
        async def execute(self, request, driver, on_event):
            await on_event(AgentRuntimeEvent(
                event_id="e1", run_id=request.run_id, seq=1, type="status",
                source="fake", timestamp="2026-06-19T00:00:00Z", payload={}))
            await on_event(AgentRuntimeEvent(
                event_id="e2", run_id=request.run_id, seq=2, type=runtime_terminal,
                source="fake", timestamp="2026-06-19T00:00:00Z", payload={}))
            return result.model_copy(update={"run_id": request.run_id})

        async def cancel(self, run_id):
            return None

    return _ScriptedExecutor()


def test_nonstandard_cancelled_error_string_keeps_run_timeline_consistency():
    """回归 #64：runtime 回非标准 cancel 串时 Run 终态与 timeline 一致。

    旧逻辑（result.error=='cancelled' 硬匹配）：error='cancelled by timeout' -> 走 else 分支
    Run=FAILED，但 timeline 末事件=run_cancelled -> Run/timeline 终态撕裂。
    新逻辑（timeline 终态事件反查）：cancelled 事件 -> run_cancelled -> Run=CANCELLED，一致。
    """
    from agent_gateway.fake_runtime import FakeDriver
    from shared.contracts.gateway import RunResult

    result = RunResult(run_id="ignored", success=False, error="cancelled by timeout")
    executor = _terminal_executor(runtime_terminal="cancelled", result=result)
    svc = build_mainline_service(executor=executor, driver=FakeDriver())
    conv = svc.create_conversation()
    run = asyncio.run(svc.start_run(conv.id))

    # Run 终态与 timeline 终态同源（都是 cancelled），不再因 error 串非标准而撕裂。
    assert run.status is RunStatus.CANCELLED
    assert run.error == "cancelled by timeout"  # 原始 error 仍作为元数据落库
    assert svc.read_timeline(conv.id, 0)[-1].type == "run_cancelled"


def test_nonstandard_failed_error_string_keeps_run_timeline_consistency():
    """回归 #64：error 事件 + 任意 error 串 -> Run=FAILED 与 timeline=run_failed 一致。"""
    from agent_gateway.fake_runtime import FakeDriver
    from shared.contracts.gateway import RunResult

    result = RunResult(run_id="ignored", success=False, error="boom: segfault at 0xff")
    executor = _terminal_executor(runtime_terminal="error", result=result)
    svc = build_mainline_service(executor=executor, driver=FakeDriver())
    conv = svc.create_conversation()
    run = asyncio.run(svc.start_run(conv.id))

    assert run.status is RunStatus.FAILED
    assert run.error == "boom: segfault at 0xff"
    assert svc.read_timeline(conv.id, 0)[-1].type == "run_failed"


def test_succeeded_run_derives_completed_from_timeline():
    """回归 #64：completed 事件 -> run_succeeded -> Run=COMPLETED（timeline 反查派生）。"""
    from agent_gateway.fake_runtime import FakeDriver
    from shared.contracts.gateway import RunResult

    result = RunResult(run_id="ignored", success=True, session_id="s1",
                       usage={"input_tokens": 1, "output_tokens": 1})
    executor = _terminal_executor(runtime_terminal="completed", result=result)
    svc = build_mainline_service(executor=executor, driver=FakeDriver())
    conv = svc.create_conversation()
    run = asyncio.run(svc.start_run(conv.id))

    assert run.status is RunStatus.COMPLETED
    assert run.session_id == "s1"
    assert run.usage == {"input_tokens": 1, "output_tokens": 1}
    assert svc.read_timeline(conv.id, 0)[-1].type == "run_succeeded"


def test_finalize_run_falls_back_to_runresult_when_no_terminal_event():
    """#64 兜底：runtime 未发终态事件（仅 RunResult）时，按 success 收尾，不崩溃。

    timeline 无终态事件是契约异常路径（正常 runtime 必发 completed/cancelled/error）；
    此处用 success=True 但无终态事件验证 fallback 走 COMPLETED，而非卡死。
    """
    from agent_gateway.fake_runtime import FakeDriver
    from shared.contracts.events import AgentRuntimeEvent
    from shared.contracts.gateway import Executor, RunResult

    class _NoTerminalExecutor(Executor):
        async def execute(self, request, driver, on_event):
            await on_event(AgentRuntimeEvent(
                event_id="e1", run_id=request.run_id, seq=1, type="status",
                source="fake", timestamp="2026-06-19T00:00:00Z", payload={}))
            # 故意不发任何终态事件
            return RunResult(run_id=request.run_id, success=True, session_id="s")

        async def cancel(self, run_id):
            return None

    svc = build_mainline_service(executor=_NoTerminalExecutor(), driver=FakeDriver())
    conv = svc.create_conversation()
    run = asyncio.run(svc.start_run(conv.id))
    assert run.status is RunStatus.COMPLETED


def test_retry_run_creates_new_run_in_same_conversation():
    """P1 gap: retry_run creates independent run in the same conversation."""
    from agent_gateway.fake_runtime import FakeDriver
    from shared.contracts.gateway import Executor, RunResult

    captured: list[dict] = []

    class _CapturingExecutor(Executor):
        async def execute(self, request, driver, on_event):
            captured.append({"run_id": request.run_id, "messages": request.input_messages})
            return RunResult(run_id=request.run_id, success=True, session_id="s1")

        async def cancel(self, run_id):
            return None

    svc = build_mainline_service(executor=_CapturingExecutor(), driver=FakeDriver())
    conv = svc.create_conversation()
    svc.add_message(conv.id, role=MessageRole.USER, content="hello")

    run1 = asyncio.run(svc.start_run(conv.id))
    assert run1.status == RunStatus.COMPLETED

    # Retry in same conversation
    run2 = asyncio.run(svc.retry_run(run1.id))
    assert run1.id != run2.id
    assert run1.conversation_id == run2.conversation_id
    assert run2.status == RunStatus.COMPLETED

    # Both runs exist
    all_runs = svc.list_runs(conv.id)
    assert len(all_runs) == 2

    # Both executions captured
    assert len(captured) == 2
    # Retry gets the same message context
    assert captured[1]["messages"] == [{"role": "user", "content": "hello"}]




def test_missing_conversation_raises():
    from shared.errors import NotFound
    svc = _svc()
    with pytest.raises(NotFound):
        svc.add_message("nope", role=MessageRole.USER, content="x")
    with pytest.raises(NotFound):
        asyncio.run(svc.start_run("nope"))
