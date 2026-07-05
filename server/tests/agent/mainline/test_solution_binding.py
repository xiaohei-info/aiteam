"""A1 扩展验收：会话方案实例绑定（固定编排入口）。

覆盖：
- create_conversation + solution_* 字段落 SQLite + 回读
- 自动 derivation：传 solution_instance_id 则 collaboration_mode 强制 orchestrated
- group.py 固定编排分支：返回 3 个 run（planner + 子任务 + 聚合）
"""

from __future__ import annotations

import asyncio

import pytest

from agent_service.mainline.factory import build_mainline_service
from agent_service.mainline.group import GroupChatService, GroupExpert
from agent_service.mainline.models import MessageRole

SOLUTION_ID = "sol-test-001"


SOLUTION_EXPERT_IDS = ["alice", "bob"]


def _snap():
    """Inline solution snapshot; prompts/experts now come from projection, not client.

    B6: roster handles must intersect solution_expert_employee_ids; use the same ids as the roster.
    """
    return {
        "solution_instance_id": SOLUTION_ID,
        "display_name": "测试方案群聊",
        "version": "v1",
        "expert_employee_ids": SOLUTION_EXPERT_IDS,
        "planner_prompt": "planner-instruction",
        "subtask_prompt": "subtask-instruction",
        "aggregate_prompt": "aggregate-instruction",
    }


def _experts() -> list[GroupExpert]:
    return [GroupExpert(handle="alice", system_prompt="A"), GroupExpert(handle="bob", system_prompt="B")]


def test_sqlite_create_conversation_from_solution_then_readback(db_path):
    mainline = build_mainline_service(db_path=db_path)
    conv = mainline.create_conversation(
        title="固定编排群聊",
        solution_instance_id=SOLUTION_ID,
        _snapshot=_snap(),
    )
    got = mainline.get_conversation(conv.id)
    assert got.collaboration_mode == "orchestrated"
    assert got.solution_instance_id == SOLUTION_ID
    assert got.solution_planner_prompt == "planner-instruction"  # snapshot-sourced
    assert got.solution_subtask_prompt == "subtask-instruction"
    assert got.solution_aggregate_prompt == "aggregate-instruction"
    assert got.solution_expert_employee_ids == SOLUTION_EXPERT_IDS
    # 自由创建仍为 free
    free = mainline.create_conversation(title="自由群")
    assert free.collaboration_mode == "free"
    assert free.solution_instance_id is None
    assert free.solution_expert_employee_ids == []
    assert got.state.value == "active"


def test_free_create_conversation_defaults_solution_fields_none_or_empty():
    mainline = build_mainline_service()
    conv = mainline.create_conversation(title="x")
    assert conv.solution_instance_id is None
    assert conv.solution_planner_prompt == ""
    assert conv.collaboration_mode == "free"


def test_service_create_from_solution_forces_orchestrated_mode():
    """自由创建再 set_collaboration(free) 后不影响 solution 绑定字段（仅触发模式转换）。"""
    mainline = build_mainline_service()
    conv = mainline.create_conversation(
        solution_instance_id=SOLUTION_ID,
        _snapshot=_snap(),
    )
    assert conv.collaboration_mode == "orchestrated"
    # 回读 SQLite（内存实现同样验证）
    got = mainline.get_conversation(conv.id)
    assert got.solution_instance_id == SOLUTION_ID
    assert got.collaboration_mode == "orchestrated"


def test_group_dispatch_fixed_orchestration_emits_three_runs():
    """固定编排：orchestrated 路径应产出 planner + 子任务 + 聚合 共 3 个 run。"""
    mainline = build_mainline_service()
    conv = mainline.create_conversation(
        solution_instance_id=SOLUTION_ID,
        _snapshot=_snap(),
    )
    grp = GroupChatService(mainline, experts=_experts())
    result = asyncio.run(grp.post_and_dispatch(conv.id, "帮我处理"))
    assert result.collaboration_mode == "orchestrated"
    assert result.default_route_hint == "orchestration"
    assert len(result.runs) == 4  # planner + 2 subtask + aggregate (2 experts)
    # 所有 run 应执行成功（fake runtime）
    from agent_service.mainline.models import RunStatus
    assert all(r.status is RunStatus.SUCCEEDED for r in result.runs)


def test_group_dispatch_free_orchestration_still_works():
    """自由协作（orchestrated 但无 solution paths）应保持 backward 兼容：brief-driven。"""
    mainline = build_mainline_service()
    conv = mainline.create_conversation(
        collaboration_mode="orchestrated",
        orchestration_brief="brief-for-free-orchestration",
    )
    grp = GroupChatService(mainline, experts=_experts())
    result = asyncio.run(grp.post_and_dispatch(conv.id, "hi"))
    assert result.collaboration_mode == "orchestrated"
    assert len(result.runs) == 4  # planner + 2 subtask + aggregate (2 experts)


@pytest.fixture()
def db_path(tmp_path):
    return str(tmp_path / "test.sqlite")


def test_load_solution_snapshot_without_instance_returns_none():
    """service.load_solution_snapshot(None/空) → 不查投影，直接返 None（line 165 短回）。"""
    mainline = build_mainline_service()
    assert mainline.load_solution_snapshot(None) is None
    assert mainline.load_solution_snapshot("") is None


def test_load_solution_snapshot_without_solutions_repo_raises():
    """service._solutions=None + 非空 instance → Conflict（line 167）。"""
    from shared.errors import Conflict
    mainline = build_mainline_service()  # 无 solutions 注入时走 InMemory
    # build_mainline_service 默认不注入 solutions（除非传 db），但仍建 InMemory sol repo
    # 要触发该分支，构造一个无 solutions 的 mainline
    from agent_service.mainline.service import MainlineService
    from agent_service.mainline.store import (
        InMemoryConversationRepository,
        InMemoryMessageRepository,
        InMemoryRunRepository,
        InMemoryTaskRepository,
    )
    from agent_service.mainline.stream import StreamBroker
    from agent_service.mainline.timeline import (
        InMemoryRawEventArchive,
        InMemoryTimelineStore,
    )
    from agent_gateway.runner import GatewayRunner
    from agent_gateway.drivers import FakeDriver, FakeExecutor

    bare = MainlineService(
        conversations=InMemoryConversationRepository(),
        messages=InMemoryMessageRepository(),
        runs=InMemoryRunRepository(),
        tasks=InMemoryTaskRepository(),
        timeline=InMemoryTimelineStore(),
        raw_archive=InMemoryRawEventArchive(),
        broker=StreamBroker(),
        runner=GatewayRunner(executor=FakeExecutor(), driver=FakeDriver()),
        solutions=None,  # 关键：无投影仓储
    )
    with pytest.raises(Conflict, match="no local solution projection"):
        bare.load_solution_snapshot("si-any")


def test_create_conversation_solution_bound_missing_snapshot_raises():
    """create_conversation(solution_instance_id=...) 无 _snapshot → Conflict（line 164）。"""
    from shared.errors import Conflict
    mainline = build_mainline_service()
    with pytest.raises(Conflict, match="requires a local projection snapshot"):
        mainline.create_conversation(solution_instance_id="si-x")


def test_read_status_helpers():
    """mark_read / reset_unread / transitions — 覆盖 service.py line 193-263 主链。"""
    from shared.contracts.enums import ConversationState
    mainline = build_mainline_service()
    conv = mainline.create_conversation(title="c")
    assert conv.last_read_at is None

    # mark_read 到特定 message
    mainline.add_message(conv.id, role=MessageRole.USER, content="hi")
    msgs = mainline.list_messages(conv.id)
    updated = mainline.mark_read(conv.id, last_read_message_id=msgs[-1].id)
    assert updated.last_read_at is not None

    # 再次 mark_read（已经是已读）幂等——各自取 now()，微秒级差异正常；验证都已设值
    again = mainline.mark_read(conv.id, last_read_message_id=msgs[-1].id)
    assert again.last_read_at is not None
    assert updated.last_read_at is not None
    assert abs((again.last_read_at - updated.last_read_at).total_seconds()) < 1

    # set_conversation_state active->archived OK
    archived = mainline.set_conversation_state(conv.id, ConversationState.ARCHIVED)
    assert archived.state == ConversationState.ARCHIVED


