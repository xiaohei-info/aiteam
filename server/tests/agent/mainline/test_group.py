"""A2 验收：群聊多专家编排 + 多 run 并入同一时间线（06 §7.6 / D19）。

本质（本卡）：
- 一个 conversation 内，按 @提及触发多个专家**各起一个 run**；
- 多 run 的归一事件**并入同一条 timeline**（A1 的 per-conversation 单调 cursor）；
- 游标仍单调、可增量拉取、可按 run_id 区分来源；多 run 交织不串、不乱序、不重号；
- @提及编排触发了预期专家集；@ 回环被阻断（红线）。

复用 A1：GroupChatService 包装 MainlineService，不重写 run/timeline/SSE/WS 主链。
"""

import asyncio

import pytest

from agent_service.mainline.factory import build_mainline_service
from agent_service.mainline.group import GroupChatService, GroupExpert
from agent_service.mainline.models import MessageRole, RunStatus


def _experts() -> list[GroupExpert]:
    return [
        GroupExpert(handle="alice", system_prompt="你是 Alice"),
        GroupExpert(handle="bob", system_prompt="你是 Bob", model="m1"),
        GroupExpert(handle="carol", system_prompt="你是 Carol"),
    ]


def _group() -> GroupChatService:
    return GroupChatService(build_mainline_service(), experts=_experts())


def test_mention_triggers_expected_expert_set():
    grp = _group()
    conv = grp.mainline.create_conversation(title="群聊")
    result = asyncio.run(grp.post_and_dispatch(conv.id, "@alice @carol 请协作"))
    # 本轮触发了被 @ 的两个专家，未触发 bob。
    assert sorted(result.triggered_handles) == ["alice", "carol"]
    assert len(result.runs) == 2
    assert all(r.status is RunStatus.COMPLETED for r in result.runs)


def test_multi_run_events_merge_into_one_timeline_monotonic():
    """多 run 并入同一 timeline：游标单调、连续、不重号。"""
    grp = _group()
    conv = grp.mainline.create_conversation()
    result = asyncio.run(grp.post_and_dispatch(conv.id, "@alice @bob 上"))

    events = grp.mainline.read_timeline(conv.id, 0)
    cursors = [e.cursor for e in events]
    # 单调且连续（per-conversation cursor，跨 run 共享同一序列）。
    assert cursors == list(range(1, len(events) + 1))
    # 包含两个 run 的事件（两个 run 各产出一整套 fake 脚本）。
    run_ids = {e.run_id for e in events}
    assert run_ids == {r.id for r in result.runs}
    assert len(run_ids) == 2


def test_events_distinguishable_by_run_id():
    """多 run 交织进同一 timeline 时可按 run_id 区分来源、各自终态齐全。"""
    grp = _group()
    conv = grp.mainline.create_conversation()
    result = asyncio.run(grp.post_and_dispatch(conv.id, "@alice @bob @carol go"))

    events = grp.mainline.read_timeline(conv.id, 0)
    by_run: dict[str, list] = {}
    for e in events:
        by_run.setdefault(e.run_id, []).append(e)

    assert set(by_run) == {r.id for r in result.runs}
    for run_id, evs in by_run.items():
        # 每个 run 自己的事件在 timeline 内 cursor 严格递增（不乱序）。
        sub = [e.cursor for e in evs]
        assert sub == sorted(sub)
        # 每个 run 都有终态事件。
        assert evs[-1].type == "run_succeeded"


def test_no_mention_dispatches_nothing():
    grp = _group()
    conv = grp.mainline.create_conversation()
    result = asyncio.run(grp.post_and_dispatch(conv.id, "大家好，没有提及任何人"))
    assert result.triggered_handles == []
    assert result.runs == []
    # 消息仍落库（用户发言记录在案）。
    assert grp.mainline.list_messages(conv.id)[-1].content == "大家好，没有提及任何人"


def test_user_message_is_persisted_with_user_role():
    grp = _group()
    conv = grp.mainline.create_conversation()
    asyncio.run(grp.post_and_dispatch(conv.id, "@alice hi"))
    msgs = grp.mainline.list_messages(conv.id)
    assert msgs[0].role is MessageRole.USER


def test_at_loop_blocked_expert_output_does_not_self_trigger():
    """红线：@ 回环阻断。

    专家产出文本里即便含 @提及，也**绝不**作为新一轮编排触发源——只有 USER 角色消息
    才进入 @提及编排。本测试用一个产出 "@bob" 的 executor 模拟专家自激尝试，断言不会
    因此再起新 run（run 数仍只等于用户本轮 @ 的专家数）。
    """
    from agent_gateway.drivers.fake_runtime import FakeDriver
    from shared.contracts.events import AgentRuntimeEvent
    from shared.contracts.gateway import Executor, RunResult

    class _MentionEmittingExecutor(Executor):
        async def execute(self, request, driver, on_event):
            await on_event(AgentRuntimeEvent(
                event_id="e1", run_id=request.run_id, seq=1, type="text_delta",
                source="fake", timestamp="2026-06-19T00:00:00Z",
                payload={"text": "@bob 你也来看看"}))
            await on_event(AgentRuntimeEvent(
                event_id="e2", run_id=request.run_id, seq=2, type="completed",
                source="fake", timestamp="2026-06-19T00:00:00Z", payload={}))
            return RunResult(run_id=request.run_id, success=True)

        async def cancel(self, run_id):
            return None

    mainline = build_mainline_service(executor=_MentionEmittingExecutor(), driver=FakeDriver())
    grp = GroupChatService(mainline, experts=_experts())
    conv = mainline.create_conversation()
    result = asyncio.run(grp.post_and_dispatch(conv.id, "@alice 开始"))
    # 用户只 @ 了 alice -> 只起 1 个 run；alice 产出的 "@bob" 不得再触发 bob 的 run。
    assert result.triggered_handles == ["alice"]
    assert len(result.runs) == 1


def test_self_mention_in_user_message_does_not_loop():
    """专家把自己也 @ 进去时（exclude 起作用），不会自起一个对自己的 run 形成回环。

    这里通过 dispatch_for_expert 走专家发起路径，验证 exclude_handle 阻断自身。
    """
    grp = _group()
    conv = grp.mainline.create_conversation()
    runs = asyncio.run(
        grp.dispatch_for_expert(conv.id, "@alice @bob", origin_handle="alice")
    )
    # alice 自身被排除，只触发 bob。
    assert len(runs) == 1
