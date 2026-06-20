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
