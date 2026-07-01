"""A2 验收增量：群聊规则编排（collaboration_mode / orchestration_brief）。

Manager 侧 app/team_panel 已实现完整编排；本端（Agent mainline）此前只支持 @提及 fan-out。
本测试验证新增的 orchestrated 分支：
- orchestrated 模式触发全量专家 + planner 拆解 + 聚合（而非仅 @提及专家）。
- orchestration_brief 被注入 planner / 各 expert / aggregate 的 run_spec.system_prompt。
- 产出与 Manager 侧一致的任务树 + default_route_hint。
"""

import asyncio

import pytest

from agent_service.mainline.factory import build_mainline_service
from agent_service.mainline.group import GroupChatService, GroupExpert
from agent_service.mainline.models import RunStatus


def _experts():
    return [
        GroupExpert(handle="alice", system_prompt="你是 Alice，研究员。"),
        GroupExpert(handle="bob", system_prompt="你是 Bob，文案。", model="m1"),
        GroupExpert(handle="carol", system_prompt="你是 Carol，审校。"),
    ]


def _captured_service():
    """构建 mainline 并劫持 start_run，记录每次调用的 run_spec。"""
    svc = build_mainline_service()
    records = []

    real_start = svc.start_run

    async def fake_start(conversation_id, *, run_spec=None, task_id=None, tenant_id=None):
        records.append({
            "conversation_id": conversation_id,
            "system_prompt": run_spec.system_prompt if run_spec else None,
            "model": run_spec.model if run_spec else None,
            "task_id": task_id,
        })
        return await real_start(
            conversation_id, run_spec=run_spec, task_id=task_id, tenant_id=tenant_id,
        )

    svc.start_run = fake_start  # type: ignore[method-assign]
    return svc, records


def test_orchestrated_mode_triggers_all_experts_without_mentions():
    """orchestrated 模式：即使没有 @提及，也应触发全量专家（不依赖 @）。"""
    svc, records = _captured_service()
    conv = svc.create_conversation(
        title="编排群",
        collaboration_mode="orchestrated",
        orchestration_brief="先调研，再撰写，最后审校。",
    )
    grp = GroupChatService(svc, experts=_experts())
    result = asyncio.run(grp.post_and_dispatch(conv.id, "完成一篇报告"))

    assert result.collaboration_mode == "orchestrated"
    assert result.default_route_hint == "orchestration"
    assert result.orchestration_brief == "先调研，再撰写，最后审校。"
    # planner + 3 experts + aggregate = 5 runs
    assert len(result.runs) == 5, result.runs
    assert result.triggered_handles == ["alice", "bob", "carol"]
    # 任务树：根(planner) + 3 子任务
    assert len(result.task_tree) == 4
    assert all(r.status is RunStatus.SUCCEEDED for r in result.runs)


def test_orchestrated_brief_injected_into_every_run_spec():
    """编排指令必须出现在 planner / 各 expert / aggregate 的 system_prompt 中。"""
    svc, records = _captured_service()
    conv = svc.create_conversation(
        collaboration_mode="orchestrated",
        orchestration_brief="先调研，再撰写，最后审校。",
    )
    asyncio.run(GroupChatService(svc, experts=_experts()).post_and_dispatch(conv.id, "完成报告"))

    brief = "先调研，再撰写，最后审校。"
    # 所有非空 prompt 都应包含编排规则头 + brief
    prompts = [r["system_prompt"] for r in records if r["system_prompt"]]
    assert len(prompts) == 5  # planner + 3 experts + aggregate
    for p in prompts:
        assert "编排规则" in p, p
        assert brief in p, p


def test_free_mode_unchanged_mention_only():
    """free 模式保持原行为：仅触发 @提及专家，不拆解不聚合。"""
    svc, records = _captured_service()
    conv = svc.create_conversation(title="自由群")  # 默认 free
    grp = GroupChatService(svc, experts=_experts())
    result = asyncio.run(grp.post_and_dispatch(conv.id, "@alice @carol 请协作"))

    assert result.collaboration_mode == "free"
    assert result.default_route_hint == "auto"
    assert result.triggered_handles == ["alice", "carol"]
    assert len(result.runs) == 2
    assert result.task_tree == []
    # free 模式不注入编排规则
    assert all("编排规则" not in (r["system_prompt"] or "") for r in records)


def test_planner_employee_id_chosen_from_roster():
    """指定 planner_employee_id 时，该专家不进入执行 roster。"""
    svc, records = _captured_service()
    conv = svc.create_conversation(
        collaboration_mode="orchestrated",
        orchestration_brief="先A后B。",
        planner_employee_id="bob",
    )
    grp = GroupChatService(svc, experts=_experts())
    result = asyncio.run(grp.post_and_dispatch(conv.id, "任务"))

    assert result.collaboration_mode == "orchestrated"
    # bob 是 planner，执行 roster = alice, carol → planner + 2 + aggregate = 4
    assert len(result.runs) == 4
    assert result.triggered_handles == ["alice", "carol"]


def test_collaboration_mode_persisted_and_switchable():
    """模式持久化，并可在 free<->orchestrated 间切换；free 清空 brief。"""
    svc, _ = _captured_service()
    conv = svc.create_conversation(
        collaboration_mode="orchestrated", orchestration_brief="先A后B。",
    )
    assert svc.get_conversation(conv.id).collaboration_mode == "orchestrated"
    assert svc.get_conversation(conv.id).orchestration_brief == "先A后B。"

    updated = svc.set_conversation_collaboration(conv.id, collaboration_mode="free")
    assert updated.collaboration_mode == "free"
    assert updated.orchestration_brief == ""

    back = svc.set_conversation_collaboration(
        conv.id, collaboration_mode="orchestrated", orchestration_brief="新指令。",
    )
    assert back.collaboration_mode == "orchestrated"
    assert back.orchestration_brief == "新指令。"


def test_orchestrated_without_brief_rejected_or_defaults():
    """orchestrated 未传 brief 时应走降级路径（每专家一子任务），不抛错。"""
    svc, records = _captured_service()
    # 显式创建 orchestrated 但空 brief：service 层允许创建，dispatch 降级
    conv = svc.create_conversation(collaboration_mode="orchestrated", orchestration_brief="")
    result = asyncio.run(GroupChatService(svc, experts=_experts()).post_and_dispatch(conv.id, "完成"))
    assert result.collaboration_mode == "orchestrated"
    # 降级路径：planner + 3 experts + aggregate，仍能跑通
    assert len(result.runs) == 5
    assert result.triggered_handles == ["alice", "bob", "carol"]


def test_orchestrated_with_no_experts_only_planner_and_aggregate():
    """无专家时 orchestrated 仍走 planner + aggregate，不崩溃。"""
    svc, records = _captured_service()
    conv = svc.create_conversation(
        collaboration_mode="orchestrated", orchestration_brief="仅汇总。",
    )
    result = asyncio.run(GroupChatService(svc, experts=[]).post_and_dispatch(conv.id, "任务"))
    assert result.collaboration_mode == "orchestrated"
    assert result.triggered_handles == []
    assert len(result.runs) == 2  # planner + aggregate
    assert len(result.task_tree) == 1  # 仅根
