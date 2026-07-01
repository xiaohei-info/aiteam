"""#158 验收：agent 本地库 SQLite 仓储 + timeline。

覆盖：与内存实现等价的仓储/timeline 行为、NotFound、**重启回读**（重开同一 db 文件数据仍在）、
迁移幂等、同会话多 run 游标连续、终态反查。只 import shared.contracts.*（枚举/事件），不重定义。
"""

from datetime import datetime, timezone

import pytest

from agent_service.local_db import apply_migrations, connect
from agent_service.mainline.models import (
    Conversation,
    Message,
    MessageRole,
    Run,
    RunStatus,
    Task,
    TaskStatus,
)
from agent_service.mainline.store import (
    SqliteConversationRepository,
    SqliteMessageRepository,
    SqliteRunRepository,
    SqliteTaskRepository,
)
from agent_service.mainline.timeline import SqliteTimelineStore
from shared.contracts.enums import ConversationState
from shared.contracts.events import BusinessTimelineEvent
from shared.errors import NotFound


def _ev(conversation_id: str, run_id: str, type: str) -> BusinessTimelineEvent:
    # cursor=0 占位，append 内重新分配。
    return BusinessTimelineEvent(
        cursor=0,
        run_id=run_id,
        conversation_id=conversation_id,
        type=type,
        payload={"k": "v"},
        created_at=datetime.now(timezone.utc),
    )


@pytest.fixture
def db_path(tmp_path):
    return str(tmp_path / "agent.db")


@pytest.fixture
def db(db_path):
    d = connect(db_path)
    apply_migrations(d)
    yield d
    d.close()


# ---- 仓储行为（与内存实现等价）----

def test_conversation_crud_and_state_transition(db):
    repo = SqliteConversationRepository(db)
    repo.create(Conversation(id="c1", title="hi"))
    assert repo.get("c1").state is ConversationState.ACTIVE
    assert repo.get("c1").title == "hi"
    updated = repo.set_state("c1", ConversationState.ARCHIVED)
    assert updated.state is ConversationState.ARCHIVED
    assert repo.get("c1").state is ConversationState.ARCHIVED


def test_conversation_missing_raises_notfound(db):
    repo = SqliteConversationRepository(db)
    with pytest.raises(NotFound):
        repo.get("nope")
    with pytest.raises(NotFound):
        repo.set_state("nope", ConversationState.PAUSED)


def test_conversation_list_ordered_by_insertion(db):
    repo = SqliteConversationRepository(db)
    for cid in ("c1", "c2", "c3"):
        repo.create(Conversation(id=cid))
    assert [c.id for c in repo.list()] == ["c1", "c2", "c3"]


def test_message_list_per_conversation_in_order(db):
    repo = SqliteMessageRepository(db)
    repo.add(Message(id="m1", conversation_id="c1", role=MessageRole.USER, content="hi"))
    repo.add(Message(id="m2", conversation_id="c1", role=MessageRole.EMPLOYEE, content="yo"))
    repo.add(Message(id="m3", conversation_id="c2", role=MessageRole.USER, content="other"))
    assert [m.id for m in repo.list("c1")] == ["m1", "m2"]
    assert [m.id for m in repo.list("c2")] == ["m3"]


def test_run_finalize_roundtrips_usage_json(db):
    repo = SqliteRunRepository(db)
    repo.create(Run(id="r1", conversation_id="c1"))
    assert repo.get("r1").status is RunStatus.QUEUED
    final = repo.finalize("r1", RunStatus.SUCCEEDED, session_id="s1",
                          error=None, usage={"input_tokens": 1})
    assert final.status is RunStatus.SUCCEEDED
    assert final.session_id == "s1"
    assert final.usage == {"input_tokens": 1}
    # usage=None 也能正确往返。
    repo.create(Run(id="r2", conversation_id="c1"))
    assert repo.finalize("r2", RunStatus.FAILED, session_id=None,
                         error="boom", usage=None).usage is None


def test_run_missing_raises_notfound(db):
    with pytest.raises(NotFound):
        SqliteRunRepository(db).get("nope")


def test_task_status_transition(db):
    repo = SqliteTaskRepository(db)
    repo.create(Task(id="t1", conversation_id="c1", title="do x"))
    assert repo.get("t1").status is TaskStatus.PENDING
    assert repo.set_status("t1", TaskStatus.DONE).status is TaskStatus.DONE


def test_task_missing_raises_notfound(db):
    with pytest.raises(NotFound):
        SqliteTaskRepository(db).get("nope")


# ---- timeline ----

def test_timeline_append_assigns_monotonic_cursor_and_read_after(db):
    store = SqliteTimelineStore(db)
    e1 = store.append(_ev("c1", "r1", "text_delta"))
    e2 = store.append(_ev("c1", "r1", "text_delta"))
    assert (e1.cursor, e2.cursor) == (1, 2)
    assert store.latest_cursor("c1") == 2
    assert [e.cursor for e in store.read_after("c1", 0)] == [1, 2]
    assert [e.cursor for e in store.read_after("c1", 1)] == [2]
    # payload 往返。
    assert store.read_after("c1", 0)[0].payload == {"k": "v"}


def test_timeline_cursor_is_per_conversation(db):
    store = SqliteTimelineStore(db)
    store.append(_ev("c1", "r1", "text_delta"))
    other = store.append(_ev("c2", "r9", "text_delta"))
    assert other.cursor == 1  # c2 自己的游标从 1 起，不受 c1 影响
    assert store.latest_cursor("c2") == 1


def test_timeline_multi_run_same_conversation_continuous(db):
    store = SqliteTimelineStore(db)
    store.append(_ev("c1", "r1", "text_delta"))
    store.append(_ev("c1", "r1", "run_succeeded"))
    e3 = store.append(_ev("c1", "r2", "text_delta"))
    assert e3.cursor == 3  # 同会话跨 run 游标连续


def test_timeline_terminal_for_run(db):
    store = SqliteTimelineStore(db)
    store.append(_ev("c1", "r1", "text_delta"))
    store.append(_ev("c1", "r1", "run_succeeded"))
    term = store.terminal_for_run("c1", "r1")
    assert term is not None and term.type == "run_succeeded"
    assert store.terminal_for_run("c1", "r2") is None


# ---- 重启回读（重开同一文件，数据仍在）----

def test_data_survives_reopen(db_path):
    d1 = connect(db_path)
    apply_migrations(d1)
    SqliteConversationRepository(d1).create(Conversation(id="c1", title="keep"))
    SqliteMessageRepository(d1).add(
        Message(id="m1", conversation_id="c1", role=MessageRole.USER, content="hi"))
    SqliteRunRepository(d1).create(Run(id="r1", conversation_id="c1"))
    SqliteTaskRepository(d1).create(Task(id="t1", conversation_id="c1", title="x"))
    SqliteTimelineStore(d1).append(_ev("c1", "r1", "text_delta"))
    d1.close()

    d2 = connect(db_path)  # 不重新建表，迁移幂等
    assert apply_migrations(d2) == []
    assert SqliteConversationRepository(d2).get("c1").title == "keep"
    assert [m.id for m in SqliteMessageRepository(d2).list("c1")] == ["m1"]
    assert SqliteRunRepository(d2).get("r1").conversation_id == "c1"
    assert SqliteTaskRepository(d2).get("t1").title == "x"
    assert SqliteTimelineStore(d2).latest_cursor("c1") == 1
    d2.close()


def test_sqlite_conversation_entry_employee_id_roundtrip_and_restart(tmp_path):
    """工作台未读链路依赖 entry_employee_id，需要 SQLite roundtrip + 重启回读。"""
    db_path = str(tmp_path / "agent_emp.db")
    d = connect(db_path)
    apply_migrations(d)
    repo = SqliteConversationRepository(d)
    repo.create(Conversation(id="c1", title="chat", entry_employee_id="emp-42"))
    assert repo.get("c1").entry_employee_id == "emp-42"
    assert [c.entry_employee_id for c in repo.list()] == ["emp-42"]
    d.close()
    d2 = connect(db_path)
    assert SqliteConversationRepository(d2).get("c1").entry_employee_id == "emp-42"
    d2.close()


def test_sqlite_conversation_read_status_roundtrip_and_restart(tmp_path):
    """SQLite read-status roundtrip + restart re-read."""
    db_path = str(tmp_path / "agent_read.db")
    d = connect(db_path)
    apply_migrations(d)
    repo = SqliteConversationRepository(d)
    conv = repo.create(Conversation(id="c1"))
    assert conv.last_read_at is None
    ts = datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)
    repo.update_read_status("c1", last_read_at=ts, last_read_message_id="msg_abc")
    got = repo.get("c1")
    assert got.last_read_at == ts
    assert got.last_read_message_id == "msg_abc"
    repo.update_read_status("c1", last_read_message_id="")
    assert repo.get("c1").last_read_message_id is None
    d.close()
    d2 = connect(db_path)
    repo2 = SqliteConversationRepository(d2)
    got2 = repo2.get("c1")
    assert got2.last_read_at == ts
    assert got2.last_read_message_id is None
    d2.close()
