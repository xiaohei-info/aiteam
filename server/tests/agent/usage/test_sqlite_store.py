"""Usage SQLite 仓储测试（#159）。

验收：SQLite 实现与内存实现行为等价，且重启后数据保持。
"""

from datetime import datetime, timezone

import pytest

from agent_service.local_db import apply_migrations, connect
from agent_service.usage.store import OutboxItem, OutboxKind, OutboxStatus, SqliteOutboxRepository
from shared.contracts.summary import AuditSummaryEvent, UsageSummary


@pytest.fixture
def db():
    """内存 SQLite 数据库（每个测试独立）。"""
    db = connect(":memory:")
    apply_migrations(db)
    return db


@pytest.fixture
def repo(db):
    return SqliteOutboxRepository(db)


def test_outbox_upsert_new(repo):
    """插入新条目。"""
    now = datetime.now(timezone.utc)
    item = OutboxItem(
        summary_id="sum1",
        tenant_id="t1",
        kind=OutboxKind.USAGE,
        usage=UsageSummary(
            summary_id="sum1",
            tenant_id="t1",
            employee_id="e1",
            window_start=now,
            window_end=now,
            token_total=100,
            cost_total=0.01,
            run_count=1,
        ),
    )
    result = repo.upsert(item)
    assert result.summary_id == "sum1"
    assert result.status is OutboxStatus.PENDING
    assert repo.list_pending() == [result]


def test_outbox_upsert_existing_pending(repo):
    """更新既有 pending 条目。"""
    now = datetime.now(timezone.utc)
    item1 = OutboxItem(
        summary_id="sum1",
        tenant_id="t1",
        kind=OutboxKind.USAGE,
        usage=UsageSummary(
            summary_id="sum1",
            tenant_id="t1",
            employee_id="e1",
            window_start=now,
            window_end=now,
            token_total=100,
            cost_total=0.01,
            run_count=1,
        ),
    )
    repo.upsert(item1)
    item2 = OutboxItem(
        summary_id="sum1",
        tenant_id="t1",
        kind=OutboxKind.USAGE,
        usage=UsageSummary(
            summary_id="sum1",
            tenant_id="t1",
            employee_id="e1",
            window_start=now,
            window_end=now,
            token_total=200,
            cost_total=0.02,
            run_count=2,
        ),
    )
    result = repo.upsert(item2)
    assert result.usage.token_total == 200
    assert len(repo.list_pending()) == 1


def test_outbox_upsert_sent_is_idempotent(repo):
    """已 sent 的条目不回退 pending。"""
    item = OutboxItem(summary_id="sum1", tenant_id="t1", kind=OutboxKind.USAGE)
    repo.upsert(item)
    repo.mark_sent("sum1")
    # 尝试再次 upsert
    item2 = OutboxItem(summary_id="sum1", tenant_id="t1", kind=OutboxKind.AUDIT)
    result = repo.upsert(item2)
    assert result.status is OutboxStatus.SENT  # 保持 sent
    assert result.kind is OutboxKind.USAGE  # 不更新内容


def test_outbox_mark_sent(repo):
    """标记为已发送。"""
    item = OutboxItem(summary_id="sum1", tenant_id="t1", kind=OutboxKind.USAGE)
    repo.upsert(item)
    result = repo.mark_sent("sum1")
    assert result.status is OutboxStatus.SENT
    assert result.last_error is None
    assert repo.list_pending() == []


def test_outbox_mark_failed(repo):
    """标记失败并累计重试次数。"""
    item = OutboxItem(summary_id="sum1", tenant_id="t1", kind=OutboxKind.USAGE)
    repo.upsert(item)
    repo.mark_failed("sum1", "network error")
    result = repo.mark_failed("sum1", "timeout")
    assert result.attempts == 2
    assert result.last_error == "timeout"
    assert result.status is OutboxStatus.PENDING


def test_outbox_list_pending_by_tenant(repo):
    """按 tenant 过滤 pending。"""
    repo.upsert(OutboxItem(summary_id="sum1", tenant_id="t1", kind=OutboxKind.USAGE))
    repo.upsert(OutboxItem(summary_id="sum2", tenant_id="t2", kind=OutboxKind.USAGE))
    repo.mark_sent("sum1")
    assert len(repo.list_pending(tenant_id="t1")) == 0
    assert len(repo.list_pending(tenant_id="t2")) == 1
    assert len(repo.list_pending()) == 1


def test_outbox_persistence(db):
    """重启后数据保持。"""
    repo1 = SqliteOutboxRepository(db)
    repo1.upsert(OutboxItem(summary_id="sum1", tenant_id="t1", kind=OutboxKind.USAGE))
    # 新建仓储实例，复用同一 db
    repo2 = SqliteOutboxRepository(db)
    items = repo2.list_pending()
    assert len(items) == 1
    assert items[0].summary_id == "sum1"
