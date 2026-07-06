"""AITEAM-689 (M1) 验收：群聊专家执行入口基于快照派生 RunSpec。

覆盖：
- GroupExpert 补齐 employee_id/provider_ref/thinking_level/skills/knowledge_refs/
  connector_refs/memory_policy；
- 群聊 @ 编排在编排服务在场时按被 @ 专家逐个冻结快照并派生 RunSpec，每个 run 记录
  自己的 snapshot_version；
- 编排服务不在场时回退到 roster 最小投影（向后兼容）。
"""

import asyncio
import os
from unittest import mock

import pytest

from agent_service.mainline.factory import build_mainline_service
from agent_service.mainline.group import GroupChatService, GroupExpert
from agent_service.mainline.models import MessageRole, RunStatus
from agent_service.mainline.execution_orchestrator import SnapshotSource


def test_group_expert_carries_snapshot_fields():
    """M1 #4：群聊专家执行入口补齐 employee_id/provider_ref/thinking_level/skills/..."""
    e = GroupExpert(
        handle="alice", employee_id="emp-1", system_prompt="你是 Alice", model="m1",
        provider_ref="relay", thinking_level="deep", skills=["code-review"],
        knowledge_refs=["kb-backend"], connector_refs=["slack"], memory_policy={"seed": "x"},
    )
    assert e.employee_id == "emp-1"
    assert e.provider_ref == "relay"
    assert e.thinking_level == "deep"
    assert e.skills == ["code-review"]
    assert e.knowledge_refs == ["kb-backend"]
    assert e.connector_refs == ["slack"]
    assert e.memory_policy == {"seed": "x"}


def test_group_expert_defaults_keep_backward_compat():
    """最小投影（仅 handle）仍合法，不破坏既有 roster 构造。"""
    e = GroupExpert(handle="bob")
    assert e.employee_id is None
    assert e.skills == []
    assert e.to_run_spec().system_prompt is None


def test_group_dispatch_derives_from_snapshot_when_orchestrator_present():
    """M1 群聊主链收口：编排服务在场时按被 @ 专家逐个冻结快照并派生 RunSpec。"""
    from tests.agent.mainline.test_execution_orchestrator import (
        FakeGrantsService, _snapshot, _make_projection,
    )

    gs = FakeGrantsService()
    snap_alice = _snapshot(
        employee_id="emp-alice", version="v1", snapshot_version="snap-a",
        persona="你是 Alice，后端专家", model="hermes-default", provider_ref="ai-relay",
        thinking_level="deep", timeout=90, skills=("code-review",),
    )
    snap_bob = _snapshot(
        employee_id="emp-bob", version="v1", snapshot_version="snap-b",
        persona="你是 Bob，前端专家", model="gpt-5", provider_ref="anthropic",
        thinking_level="basic", timeout=60, skills=("testing",),
    )
    gs.client.snapshots["emp-alice"] = snap_alice
    gs.client.snapshots["emp-bob"] = snap_bob
    gs._svc._client.snapshots["emp-alice"] = snap_alice
    gs._svc._client.snapshots["emp-bob"] = snap_bob
    gs.projections.upsert(_make_projection("emp-alice", "v1"))
    gs.projections.upsert(_make_projection("emp-bob", "v1"))

    from agent_service.mainline.execution_orchestrator import ExecutionOrchestrator
    orch = ExecutionOrchestrator(
        grants=gs._svc, projections=gs.projections, tenant_id="t1", member_id="m1",
    )

    roster = [
        GroupExpert(handle="alice", employee_id="emp-alice"),
        GroupExpert(handle="bob", employee_id="emp-bob"),
    ]
    svc = build_mainline_service(orchestrator=orch)
    grp = GroupChatService(svc, experts=roster, orchestrator=orch)
    conv = svc.create_conversation(title="群聊")
    # AITEAM-690 后 start_run 经 gateway provider_resolver 按 provider_ref 解析 host env（D18 fail-fast）。
    # 使用已注册的 provider_ref 并补齐对应 env，聚焦验证快照派生与调度语义本身。
    with mock.patch.dict(
        os.environ, {"AI_RELAY_TOKEN": "relay-tok", "ANTHROPIC_API_KEY": "sk-anthropic-x"}
    ):
        result = asyncio.run(grp.post_and_dispatch(conv.id, "@alice @carol 请协作"))
    # carol 不在 roster → 不触发；alice 触发。
    assert result.triggered_handles == ["alice"]
    assert len(result.runs) == 1
    run = result.runs[0]
    assert run.status is RunStatus.SUCCEEDED
    # 每个 run 记录自己的快照版本。
    assert run.snapshot_version == "snap-a"
    assert run.snapshot_source == SnapshotSource.FROZEN
    assert run.employee_id == "emp-alice"
    assert run.skill_refs == ["code-review"]


def test_group_dispatch_falls_back_to_roster_when_no_orchestrator():
    """编排服务不在场时回退到 roster 最小投影（向后兼容，不抛错）。"""
    roster = [
        GroupExpert(handle="alice", system_prompt="你是 Alice", model="m1"),
        GroupExpert(handle="bob", system_prompt="你是 Bob"),
    ]
    svc = build_mainline_service()
    grp = GroupChatService(svc, experts=roster)
    conv = svc.create_conversation(title="群聊")
    result = asyncio.run(grp.post_and_dispatch(conv.id, "@alice 你好"))
    assert result.triggered_handles == ["alice"]
    assert len(result.runs) == 1
    # 无快照绑定。
    assert result.runs[0].snapshot_version is None
    assert result.runs[0].snapshot_source == "none"
