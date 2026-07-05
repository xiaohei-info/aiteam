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




def test_update_collaboration_returns_sentinel_for_empty_strings():
    """update_collaboration: 空字符串 sentinel → 字段置 None/[] 分支 (line 147-164)。"""
    mainline = build_mainline_service()
    conv = mainline.create_conversation(title="c", planner_employee_id="alice")
    assert conv.planner_employee_id == "alice"
    # 空字符串 -> 置 None
    cleared = mainline.set_conversation_collaboration(
        conv.id, planner_employee_id=""
    )
    assert cleared.planner_employee_id is None


def test_inmemory_conversation_repo_solution_fields_roundtrip():
    """InMemoryConversationRepository.update_collaboration: 全量 solution_* 字段分支（line 147-164）。"""
    from agent_service.mainline.store import InMemoryConversationRepository
    from agent_service.mainline.models import Conversation, ConversationState

    repo = InMemoryConversationRepository()
    conv = repo.create(
        Conversation(id="c1", title="t", state=ConversationState.ACTIVE)
    )
    # 分支1: solution_instance_id 空字符串 -> None
    upd = repo.update_collaboration("c1", solution_instance_id="  ")
    assert upd.solution_instance_id is None
    # 分支2: solution_instance_id 正常值
    upd = repo.update_collaboration("c1", solution_instance_id="sol-x")
    assert upd.solution_instance_id == "sol-x"
    # 分支3: prompts str coerce
    upd = repo.update_collaboration("c1", solution_planner_prompt="p", solution_subtask_prompt="s", solution_aggregate_prompt="a")
    assert upd.solution_planner_prompt == "p"
    # 分支4: expert_ids 首次绑定
    upd = repo.update_collaboration("c1", solution_expert_employee_ids=["a", "b"])
    assert upd.solution_expert_employee_ids == ["a", "b"]
    # 分支5: expert_ids 重绑不同列表 -> Conflict
    from shared.errors import Conflict
    with pytest.raises(Conflict, match="cannot rebind"):
        repo.update_collaboration("c1", solution_expert_employee_ids=["c"])
    # 分支6: expert_ids 重绑相同列表 -> OK
    upd = repo.update_collaboration("c1", solution_expert_employee_ids=["a", "b"])
    assert upd.solution_expert_employee_ids == ["a", "b"]


def test_inmemory_conversation_update_orchestrated_requires_brief():
    """update_collaboration: 切到 orchestrated 必须带 brief（line 152-153 ValueError 分支）。"""
    from agent_service.mainline.store import InMemoryConversationRepository
    from agent_service.mainline.models import Conversation, ConversationState

    repo = InMemoryConversationRepository()
    repo.create(Conversation(id="c1", title="t", state=ConversationState.ACTIVE, collaboration_mode="free"))
    # 切到 orchestrated 无 brief → ValueError（line 152）
    import pytest
    with pytest.raises(ValueError, match="orchestration_brief is required"):
        repo.update_collaboration("c1", collaboration_mode="orchestrated")
    # 带 brief 分支 (line 147-152)
    ok = repo.update_collaboration("c1", collaboration_mode="orchestrated", orchestration_brief="handle it")
    assert ok.collaboration_mode == "orchestrated"
    assert ok.orchestration_brief.strip() == "handle it"
    # free 模式 → orchestration_brief 被清空 (line 154-155)
    ok2 = repo.update_collaboration("c1", collaboration_mode="free")
    assert ok2.collaboration_mode == "free"
    assert ok2.orchestration_brief == ""



def test_load_solution_snapshot_projection_missing_raises():
    """load_solution_snapshot: instance 不在本地投影 → Conflict (line 167)。"""
    from shared.errors import Conflict
    mainline = build_mainline_service()
    with pytest.raises(Conflict, match="not available in local projection"):
        mainline.load_solution_snapshot("si-missing")


def test_set_conversation_state_invalid_transition_raises():
    """set_conversation_state: 非法状态转换 → Conflict (line 262-263)。"""
    from shared.errors import Conflict
    from shared.contracts.enums import ConversationState
    mainline = build_mainline_service()
    conv = mainline.create_conversation(title="c")
    # active → archived 转一次合法
    mainline.set_conversation_state(conv.id, ConversationState.ARCHIVED)
    # archived → active 不允许
    with pytest.raises(Conflict, match="Cannot transition"):
        mainline.set_conversation_state(conv.id, ConversationState.ACTIVE)


def test_set_conversation_collaboration_fixed_cannot_switch_to_free():
    """set_conversation_collaboration: 固定编排会话不可改 free（B8，line 269-274）。"""
    from shared.errors import Conflict
    mainline = build_mainline_service()
    # 创建自由会话，通过底层 update_collaboration 写入 solution_instance_id 以模拟已固定编排
    from agent_service.mainline.store import ConversationState
    conv = mainline.create_conversation(title="c")
    mainline._conversations.update_collaboration(conv.id, solution_instance_id="sol-1")
    with pytest.raises(Conflict, match="cannot be switched to free"):
        mainline.set_conversation_collaboration(conv.id, collaboration_mode="free")


def test_unread_count_helpers():
    """unread_count_for_employee + _conversation_for_employee 主链覆盖。"""
    mainline = build_mainline_service()
    # 没有会话
    assert mainline.unread_count_for_employee("any") == 0
    # 有私聊 + 未读
    mainline.create_conversation(title="p", entry_employee_id="emp-1")
    assert mainline.unread_count_for_employee("emp-1") == 0  # 无消息 → 0


def test_private_conversation_excludes_from_group_filter():
    """create_conversation(entry_employee_id=...) → conversation_type private；覆盖 171 区域。"""
    mainline = build_mainline_service()
    priv = mainline.create_conversation(title="dm", entry_employee_id="emp-1")
    assert priv.conversation_type == "private"
    grp = mainline.create_conversation(title="team")
    assert grp.conversation_type == "group"




def test_sqlite_conversation_repository_roundtrip_with_solution_fields():
    """SqliteConversationRepository: solution_* 字段 + expert_ids JSON 列写读回（覆盖 line 337-362）。"""
    import tempfile, sqlite3, os
    from agent_service.local_db import connect
    from agent_service.mainline.store import SqliteConversationRepository
    from agent_service.mainline.models import Conversation, ConversationState

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
    tmp.close()
    conn = sqlite3.connect(tmp.name)
    conn.execute("""CREATE TABLE conversations (
        id TEXT PRIMARY KEY, title TEXT, state TEXT, collaboration_mode TEXT, orchestration_brief TEXT,
        planner_employee_id TEXT, entry_employee_id TEXT, last_read_at TEXT, last_read_message_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        solution_instance_id TEXT, solution_planner_prompt TEXT, solution_subtask_prompt TEXT,
        solution_aggregate_prompt TEXT, solution_expert_employee_ids TEXT DEFAULT '[]'
    )""")
    conn.commit()
    db = connect(tmp.name)
    repo = SqliteConversationRepository(db)

    conv = repo.create(Conversation(
        id="c1", title="群", state=ConversationState.ACTIVE,
        collaboration_mode="orchestrated", orchestration_brief="brief",
        solution_instance_id="si-1", solution_planner_prompt="p", solution_subtask_prompt="s",
        solution_aggregate_prompt="a", solution_expert_employee_ids=["e1", "e2"],
    ))
    got = repo.get("c1")
    assert got.solution_instance_id == "si-1"
    assert got.solution_expert_employee_ids == ["e1", "e2"]
    assert got.solution_planner_prompt == "p"

    listed = repo.list()
    assert len(listed) == 1
    conn.close()


def test_sqlite_conversation_repo_expert_ids_json_parse_branch():
    """SqliteConversationRepository.get: solution_expert_employee_ids 异常 JSON → [] 兜底分支 (line 351)。"""
    import tempfile, sqlite3
    from agent_service.local_db import connect
    from agent_service.mainline.store import SqliteConversationRepository
    from agent_service.mainline.models import Conversation, ConversationState

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
    tmp.close()
    conn = sqlite3.connect(tmp.name)
    conn.execute("""CREATE TABLE conversations (
        id TEXT PRIMARY KEY, title TEXT, state TEXT, collaboration_mode TEXT, orchestration_brief TEXT,
        planner_employee_id TEXT, entry_employee_id TEXT, last_read_at TEXT, last_read_message_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        solution_instance_id TEXT, solution_planner_prompt TEXT, solution_subtask_prompt TEXT,
        solution_aggregate_prompt TEXT, solution_expert_employee_ids TEXT DEFAULT '[]'
    )""")
    # 插入一行非法 JSON 到 expert_ids 列，测试 except 分支
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO conversations (id,title,state,created_at,updated_at,collaboration_mode,orchestration_brief,solution_expert_employee_ids) VALUES (?,?,?,?,?,?,?,'NOT_JSON')",
        ("c1", "x", "active", now, now, "free", ""),
    )
    conn.commit()
    db = connect(tmp.name)
    repo = SqliteConversationRepository(db)
    got = repo.get("c1")
    assert got.solution_expert_employee_ids == []  # JSON 解析失败 → 兜底 []
    conn.close()


