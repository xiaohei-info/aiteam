"""A1.2 验收：timeline store 游标增量。

覆盖：cursor 严格单调、增量拉取边界（after=0/中段/末尾）、per-conversation 隔离、
latest_cursor、raw archive 仅写不对外读。
parity：MVP read_run_events(after_seq) -> v1 read_after(after_cursor)。
"""

from agent_service.mainline.timeline import (
    InMemoryRawEventArchive,
    InMemoryTimelineStore,
)
from shared.contracts.events import AgentRuntimeEvent, BusinessTimelineEvent


def _biz(conversation_id="c1", type_="message_delta") -> BusinessTimelineEvent:
    return BusinessTimelineEvent(
        cursor=0, run_id="r1", conversation_id=conversation_id, type=type_,
        payload={}, created_at="2026-06-19T00:00:00Z",
    )


def test_cursor_strictly_monotonic_from_one():
    store = InMemoryTimelineStore()
    cursors = [store.append(_biz()).cursor for _ in range(5)]
    assert cursors == [1, 2, 3, 4, 5]


def test_read_after_zero_returns_all():
    store = InMemoryTimelineStore()
    for _ in range(3):
        store.append(_biz())
    assert [e.cursor for e in store.read_after("c1", 0)] == [1, 2, 3]


def test_read_after_middle_returns_tail():
    store = InMemoryTimelineStore()
    for _ in range(5):
        store.append(_biz())
    assert [e.cursor for e in store.read_after("c1", 3)] == [4, 5]


def test_read_after_last_returns_empty():
    store = InMemoryTimelineStore()
    for _ in range(3):
        store.append(_biz())
    assert store.read_after("c1", 3) == []


def test_per_conversation_isolation_and_independent_cursors():
    store = InMemoryTimelineStore()
    a = store.append(_biz("cA"))
    b = store.append(_biz("cB"))
    # 各会话游标独立，都从 1 起。
    assert a.cursor == 1 and b.cursor == 1
    assert [e.conversation_id for e in store.read_after("cA", 0)] == ["cA"]
    assert [e.conversation_id for e in store.read_after("cB", 0)] == ["cB"]


def test_latest_cursor():
    store = InMemoryTimelineStore()
    assert store.latest_cursor("c1") == 0
    store.append(_biz())
    store.append(_biz())
    assert store.latest_cursor("c1") == 2


def test_raw_archive_write_only():
    archive = InMemoryRawEventArchive()
    rt = AgentRuntimeEvent(event_id="e1", run_id="r1", seq=1, type="status",
                           source="fake", timestamp="2026-06-19T00:00:00Z")
    archive.archive(rt)
    assert archive._debug_count() == 1
    # 归档不提供任何对外读接口（只 archive + 调试用 _debug_count）。
    public = [a for a in dir(archive) if not a.startswith("_")]
    assert public == ["archive"]


# ---- #64 终态单一真相源：terminal_for_run 反查 ----


def _biz_run(run_id="r1", conversation_id="c1", type_="message_delta") -> BusinessTimelineEvent:
    return BusinessTimelineEvent(
        cursor=0, run_id=run_id, conversation_id=conversation_id, type=type_,
        payload={}, created_at="2026-06-19T00:00:00Z",
    )


def test_terminal_for_run_returns_last_terminal_event():
    """#64：取该 run 在时间线上最后一条终态事件（逆序最新）。"""
    store = InMemoryTimelineStore()
    store.append(_biz_run(type_="message_delta"))
    store.append(_biz_run(type_="run_failed"))
    store.append(_biz_run(type_="run_succeeded"))  # 同 run 多终态时取最后一条
    ev = store.terminal_for_run("c1", "r1")
    assert ev is not None
    assert ev.type == "run_succeeded"


def test_terminal_for_run_returns_none_when_no_terminal():
    store = InMemoryTimelineStore()
    store.append(_biz_run(type_="status"))
    store.append(_biz_run(type_="message_delta"))
    assert store.terminal_for_run("c1", "r1") is None


def test_terminal_for_run_isolates_by_run_and_conversation():
    store = InMemoryTimelineStore()
    store.append(_biz_run(run_id="r1", conversation_id="c1", type_="run_succeeded"))
    store.append(_biz_run(run_id="r2", conversation_id="c1", type_="run_failed"))
    store.append(_biz_run(run_id="r3", conversation_id="c2", type_="run_cancelled"))
    assert store.terminal_for_run("c1", "r1").type == "run_succeeded"
    assert store.terminal_for_run("c1", "r2").type == "run_failed"
    # 其它会话的 run 不串
    assert store.terminal_for_run("c1", "r3") is None
    assert store.terminal_for_run("c2", "r3").type == "run_cancelled"
