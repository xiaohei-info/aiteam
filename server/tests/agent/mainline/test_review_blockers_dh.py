"""AITEAM-374 D-H: hermes-reviewer second-round blockers 一次性修复验收。

D: 固定编排执行阶段不使用客户端 roster 的 system_prompt/model（防伪造）。
E: group-dispatch 拒绝私聊会话（409）；Conversation.conversation_type 区分群/私。
F: 自由群聊创建入口与后端 create_conversation(free) 契约。
G: SolutionProjection.version 兼容 Manager 下发的 solution_version:config_version。
H: SQLite 读写 round-trip 保留 template_solution_id。
"""
from __future__ import annotations

import asyncio

import pytest

from agent_service.grants.service import GrantsService
from agent_service.grants.store import (
    InMemoryProjectionRepository,
    InMemorySnapshotRepository,
    InMemorySolutionProjectionRepository,
    SqliteSolutionProjectionRepository,
)
from agent_service.mainline.factory import build_mainline_service
from agent_service.mainline.group import GroupChatService, GroupExpert
from agent_service.mainline.models import Conversation, RunStatus


# ── D: fixed-mode executor subtasks must ignore client-supplied system_prompt/model ──

SOLUTION_ID = "sol-fixed-trust"
SOLUTION_EXPERT_IDS = ["alice", "bob"]


def _snap():
    return {
        "solution_instance_id": SOLUTION_ID,
        "display_name": "信任测试方案",
        "version": "v1",
        "expert_employee_ids": SOLUTION_EXPERT_IDS,
        "planner_prompt": "PLANNER_FROM_SOLUTION",
        "subtask_prompt": "SUBTASK_FROM_SOLUTION",
        "aggregate_prompt": "AGGREGATE_FROM_SOLUTION",
    }


def _poisoned_roster():
    """Client-supplied poisoned system_prompt/model that must be IGNORED in fixed mode."""
    return [
        GroupExpert(handle="alice", system_prompt="CLIENT_EVIL_PROMPT", model="evil-model"),
        GroupExpert(handle="bob", system_prompt="CLIENT_EVIL_PROMPT", model="evil-model"),
    ]


def _captured_service():
    svc = build_mainline_service()
    records = []
    real_start = svc.start_run

    async def fake_start(conversation_id, *, run_spec=None, task_id=None, tenant_id=None):
        records.append({
            "system_prompt": run_spec.system_prompt if run_spec else None,
            "model": run_spec.model if run_spec else None,
            "task_id": task_id,
        })
        return await real_start(conversation_id, run_spec=run_spec, task_id=task_id, tenant_id=tenant_id)

    svc.start_run = fake_start  # type: ignore[method-assign]
    return svc, records


def test_fixed_mode_ignores_client_roster_prompts_and_model():
    """固定编排：子任务 RunSpec 不包含客户端传入的 system_prompt/model。"""
    svc, records = _captured_service()
    conv = svc.create_conversation(
        solution_instance_id=SOLUTION_ID, _snapshot=_snap(),
    )
    grp = GroupChatService(svc, experts=_poisoned_roster())
    result = asyncio.run(grp.post_and_dispatch(conv.id, "任务"))

    assert result.collaboration_mode == "orchestrated"
    # 每个子任务（executor）的 run_spec 都不含客户端注入的 system_prompt/model
    for rec in records:
        sp = rec["system_prompt"] or ""
        assert "CLIENT_EVIL_PROMPT" not in sp, f"poisoned prompt leaked: {sp}"
        assert rec["model"] != "evil-model", "poisoned model leaked"


def test_fixed_mode_uses_solution_prompts_for_execution():
    """固定编排：子任务来自方案级 subtask_prompt/planner_prompt/aggregate_prompt。"""
    svc, records = _captured_service()
    conv = svc.create_conversation(
        solution_instance_id=SOLUTION_ID, _snapshot=_snap(),
    )
    asyncio.run(GroupChatService(svc, experts=_poisoned_roster()).post_and_dispatch(conv.id, "任务"))
    prompts = [r["system_prompt"] or "" for r in records]
    # planner + aggregate 使用方案级 prompt
    assert any("PLANNER" in p for p in prompts), prompts
    assert any("AGGREGATE" in p for p in prompts), prompts
    # executor 子任务使用方案级 subtask_prompt
    assert any("SUBTASK_FROM_SOLUTION" in p for p in prompts), prompts


def test_free_mode_still_uses_roster_persona_and_model():
    """自由协作：roster 的 system_prompt/model 仍注入，保持向后兼容。"""
    svc, records = _captured_service()
    conv = svc.create_conversation(
        collaboration_mode="orchestrated",
        orchestration_brief="自由 brief",
    )
    roster = [
        GroupExpert(handle="alice", system_prompt="PERSONA_ALICE", model="model-alice"),
        GroupExpert(handle="bob", system_prompt="PERSONA_BOB", model="model-bob"),
    ]
    asyncio.run(GroupChatService(svc, experts=roster).post_and_dispatch(conv.id, "任务"))
    prompts = [r["system_prompt"] or "" for r in records]
    assert any("PERSONA_ALICE" in p for p in prompts), prompts
    models = [r["model"] for r in records]
    assert "model-alice" in models or "model-bob" in models, models


# ── E: group-dispatch rejects private (entry_employee_id set) conversations ──

def test_group_dispatch_rejects_private_conversation_via_route():
    """私聊会话（entry_employee_id 非空）不可走 group-dispatch；路由层 409。"""
    from httpx import ASGITransport, AsyncClient

    from agent_service.app import build_app
    from shared.errors import Conflict

    mainline = build_mainline_service()
    # 私聊会话：entry_employee_id 非空
    priv = mainline.create_conversation(title="私聊A", entry_employee_id="emp-x")
    # 群聊会话：entry_employee_id 为空
    grp = mainline.create_conversation(title="群聊A")
    # 落库后取最新 projection（无 solutions 创建）
    app = build_app(mainline_service=mainline)

    async def run():
        transport = ASGITransport(app=app)  # type: ignore[arg-type]
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            # 私聊 -> 409 Conflict
            resp = await ac.post(
                f"/api/agent/conversations/{priv.id}/group-dispatch",
                json={"text": "@alice 你好", "experts": [{"handle": "alice"}]},
            )
            assert resp.status_code == 409, resp.status_code
            # 群聊 -> 200
            resp2 = await ac.post(
                f"/api/agent/conversations/{grp.id}/group-dispatch",
                json={"text": "@alice 你好", "experts": [{"handle": "alice"}]},
            )
            assert resp2.status_code == 200, resp2.status_code

    asyncio.run(run())


def test_conversation_type_distinguishes_group_and_private():
    """Conversation.conversation_type：群聊=group，私聊=private。"""
    svc = build_mainline_service()
    priv = svc.create_conversation(title="private", entry_employee_id="emp-x")
    assert priv.conversation_type == "private"
    grp = svc.create_conversation(title="group")
    assert grp.conversation_type == "group"
    from_solution = svc.create_conversation(
        title="solution", solution_instance_id=SOLUTION_ID, _snapshot=_snap(),
    )
    assert from_solution.conversation_type == "group"  # solution-bound 仍是群聊会话


# ── F: free conversation creation returns collaboration_mode=free ──

def test_create_conversation_without_solution_defaults_to_free_group_chat():
    """自由群聊创建：无 solution → collaboration_mode=free + type=group。"""
    svc = build_mainline_service()
    conv = svc.create_conversation(title="自由协作群")
    assert conv.collaboration_mode == "free"
    assert conv.conversation_type == "group"
    assert conv.solution_instance_id is None
    assert conv.solution_planner_prompt == ""


# ── G: SolutionProjection.version from solution_version:config_version composite ──

class _FakeClientG:
    def pull_authorized_config(self, request):
        class R:
            experts = []
            solutions = [
                {
                    "id": "si-1",
                    "solution_id": "tpl-1",
                    "solution_version": "sv-3",
                    "config_version": 7,
                    "display_name": "电商群",
                    "expert_employee_ids": ["emp-1"],
                    # 注意：Manager 不再下发顶层 "version"
                    "planner_prompt": "p",
                    "subtask_prompt": "s",
                    "aggregate_prompt": "a",
                },
            ]
            revoked_ids = []
        return R()

    def pull_snapshot(self, request):
        raise NotImplementedError


def test_solution_projection_version_uses_composite():
    """version 字段由 Manager 下发的 solution_version:config_version 组合填充。"""
    store = InMemorySolutionProjectionRepository()
    store.upsert({
        "id": "si-1",
        "solution_id": "tpl-1",
        "solution_version": "sv-3",
        "config_version": 7,
        "display_name": "电商群",
        "expert_employee_ids": ["emp-1"],
        "planner_prompt": "p",
        "subtask_prompt": "s",
        "aggregate_prompt": "a",
    })
    proj = store.get("si-1")
    assert proj is not None
    assert proj.version == "sv-3:7", proj.version
    assert proj.template_solution_id == "tpl-1", proj.template_solution_id


def test_solution_projection_version_falls_back_to_top_level_if_present():
    """兼容旧版 Manager 若显式下发 version。"""
    store = InMemorySolutionProjectionRepository()
    store.upsert({
        "id": "si-2",
        "template_solution_id": "tpl-x",
        "version": "legacy-v9",
        "display_name": "x",
    })
    proj = store.get("si-2")
    assert proj is not None
    assert proj.version == "legacy-v9", proj.version


def test_solution_projection_version_in_list_available_after_sync():
    """sync 后 list_available_solutions() 返回的 version 非空。"""
    svc = GrantsService(
        client=_FakeClientG(),
        projections=InMemoryProjectionRepository(),
        snapshots=InMemorySnapshotRepository(),
        solutions=InMemorySolutionProjectionRepository(),
    )
    svc.sync("t1", "m1")
    items = svc.list_available_solutions()
    assert len(items) == 1
    assert items[0]["version"] != "", items[0]
    assert items[0]["version"] == "sv-3:7", items[0]


# ── H: SQLite round-trip preserves template_solution_id ──

@pytest.fixture()
def db_path(tmp_path):
    return str(tmp_path / "test.sqlite")


def test_sqlite_solution_projection_roundtrips_template_solution_id(db_path):
    """SQLite 投影仓储 upsert/get 完整保留 template_solution_id。"""
    from agent_service.local_db import apply_migrations, connect
    db = connect(db_path)
    apply_migrations(db)
    repo = SqliteSolutionProjectionRepository(db)
    repo.upsert({
        "id": "si-1",
        "solution_id": "tpl-1",
        "solution_version": "sv-1",
        "config_version": 2,
        "display_name": "电商群",
        "expert_employee_ids": ["emp-1", "emp-2"],
        "planner_prompt": "p",
        "subtask_prompt": "s",
        "aggregate_prompt": "a",
    })
    got = repo.get("si-1")
    assert got is not None
    assert got.template_solution_id == "tpl-1", got.template_solution_id
    assert got.version == "sv-1:2", got.version
    assert got.expert_employee_ids == ["emp-1", "emp-2"], got.expert_employee_ids


def test_sqlite_solution_projection_column_exists(db_path):
    from agent_service.local_db import apply_migrations, connect
    import sqlite3
    db_path2 = db_path + "2"
    conn = sqlite3.connect(db_path2)
    conn.execute(
        "CREATE TABLE solution_projections ("
        "solution_id TEXT PRIMARY KEY, display_name TEXT, version TEXT, "
        "expert_employee_ids TEXT, template_solution_id TEXT,"
        "planner_prompt TEXT, subtask_prompt TEXT, aggregate_prompt TEXT)"
    )
    cols = {r[1] for r in conn.execute("PRAGMA table_info(solution_projections)")}
    conn.close()
    assert "template_solution_id" in cols
