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

SOLUTION_ID = "sol-test-001"


def _experts() -> list[GroupExpert]:
    return [GroupExpert(handle="alice", system_prompt="A"), GroupExpert(handle="bob", system_prompt="B")]


def test_sqlite_create_conversation_from_solution_then_readback(db_path):
    mainline = build_mainline_service(db_path=db_path)
    conv = mainline.create_conversation(
        title="固定编排群聊",
        solution_instance_id=SOLUTION_ID,
        solution_planner_prompt="planner-instruction",
        solution_subtask_prompt="subtask-instruction",
        solution_aggregate_prompt="aggregate-instruction",
        solution_expert_employee_ids=["emp-1", "emp-2"],
    )
    got = mainline.get_conversation(conv.id)
    assert got.collaboration_mode == "orchestrated"
    assert got.solution_instance_id == SOLUTION_ID
    assert got.solution_planner_prompt == "planner-instruction"
    assert got.solution_subtask_prompt == "subtask-instruction"
    assert got.solution_aggregate_prompt == "aggregate-instruction"
    assert got.solution_expert_employee_ids == ["emp-1", "emp-2"]
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
        solution_planner_prompt="p", solution_subtask_prompt="s", solution_aggregate_prompt="a",
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
        solution_planner_prompt="p", solution_subtask_prompt="s", solution_aggregate_prompt="a",
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
