"""A5 验收：OutboxItem 三态（pending/retry/failed）(#293)。

failed 态为终态：attempts 达到阈值后转入 failed，drain 不再重试；list_pending 排除 failed。
"""
from __future__ import annotations

import pytest

from agent_service.local_db import apply_migrations, connect
from agent_service.usage.store import (
    InMemoryOutboxRepository,
    OutboxItem,
    OutboxKind,
    OutboxStatus,
    SqliteOutboxRepository,
)


@pytest.fixture
def mem():
    return InMemoryOutboxRepository(max_retries=2)


@pytest.fixture
def db():
    db = connect(":memory:")
    apply_migrations(db)
    return db


@pytest.fixture
def sqlite(db):
    return SqliteOutboxRepository(db, max_retries=2)


def _mk(summary_id="s1", tenant_id="t1"):
    return OutboxItem(summary_id=summary_id, tenant_id=tenant_id, kind=OutboxKind.USAGE)


@pytest.mark.parametrize("repo", ["mem", "sqlite"])
def test_failed_is_terminal(repo, request):
    r = request.getfixturevalue(repo)
    r.upsert(_mk())
    r.mark_failed("s1", "boom")        # attempts=1, still pending (未达阈值)
    assert r.get("s1").status is OutboxStatus.PENDING
    r.mark_failed("s1", "boom")        # attempts=2 → 触阈 → failed
    item = r.get("s1")
    assert item.status is OutboxStatus.FAILED
    assert item.attempts == 2
    assert item.last_error == "boom"


@pytest.mark.parametrize("repo", ["mem", "sqlite"])
def test_list_pending_excludes_failed(repo, request):
    r = request.getfixturevalue(repo)
    r.upsert(_mk("s1"))
    r.upsert(_mk("s2"))
    r.mark_failed("s1", "x")
    r.mark_failed("s1", "x")           # s1 → failed
    assert [i.summary_id for i in r.list_pending()] == ["s2"]
    assert [i.summary_id for i in r.list_failed()] == ["s1"]


@pytest.mark.parametrize("repo", ["mem", "sqlite"])
def test_sent_stays_sent_after_failed_calls_guard(repo, request):
    """已 sent 的条目不可被 mark_failed 回退。"""
    r = request.getfixturevalue(repo)
    r.upsert(_mk())
    r.mark_sent("s1")
    r.mark_failed("s1", "too late")
    item = r.get("s1")
    assert item.status is OutboxStatus.SENT
    assert item.attempts == 0


def test_default_max_retries_allows_several_attempts():
    """默认 max_retries=3：前 2 次仍 pending，第 3 次触阈转 failed。"""
    r = InMemoryOutboxRepository()  # default max_retries=3
    r.upsert(_mk())
    r.mark_failed("s1", "x")  # attempts=1
    r.mark_failed("s1", "x")  # attempts=2, 仍 pending（未达阈值）
    assert r.get("s1").status is OutboxStatus.PENDING
    r.mark_failed("s1", "x")  # attempts=3 ≥ 3 → failed 终态
    assert r.get("s1").status is OutboxStatus.FAILED
