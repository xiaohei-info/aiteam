"""A5 验收：outbox 幂等/不丢/不重复 + reporter 失败重试（04 §6.5 可靠性 / 05 F13）。

覆盖：enqueue 幂等（同 summary_id 不产生重复条目）、上报成功 pending→sent、失败留 pending
可重试、已 sent 不重复上报、按 Idempotency-Key 上报、UnconfiguredUsageClient 安全失败。
"""

import pytest

from agent_service.usage.client import UnconfiguredUsageClient
from agent_service.usage.factory import build_usage_service
from agent_service.usage.models import RawUsageEvent
from agent_service.usage.reporter import UsageReporter
from agent_service.usage.store import (
    InMemoryOutboxRepository,
    OutboxItem,
    OutboxKind,
    OutboxStatus,
)
from shared.contracts.crosstier import UsageSummaryUpload
from shared.contracts.summary import UsageSummary
from datetime import datetime, timezone


def _summary(sid: str, tenant: str = "t1") -> UsageSummary:
    now = datetime(2026, 6, 18, 10, 0, tzinfo=timezone.utc)
    return UsageSummary(summary_id=sid, tenant_id=tenant, employee_id="e1",
                        window_start=now, window_end=now, token_total=5)


class CapturingClient:
    def __init__(self) -> None:
        self.calls: list[tuple[UsageSummaryUpload, str]] = []

    def upload(self, payload: UsageSummaryUpload, *, idempotency_key: str) -> None:
        self.calls.append((payload, idempotency_key))


class FlakyClient:
    """前 N 次上报失败，之后成功——验证失败重试且不丢。"""

    def __init__(self, fail_times: int) -> None:
        self.fail_times = fail_times
        self.attempts = 0

    def upload(self, payload: UsageSummaryUpload, *, idempotency_key: str) -> None:
        self.attempts += 1
        if self.attempts <= self.fail_times:
            raise RuntimeError("manager unreachable")


# ---- outbox 幂等 ----

def test_outbox_upsert_is_idempotent_by_summary_id():
    repo = InMemoryOutboxRepository()
    repo.upsert(OutboxItem(summary_id="s1", tenant_id="t1", kind=OutboxKind.USAGE,
                           usage=_summary("s1")))
    repo.upsert(OutboxItem(summary_id="s1", tenant_id="t1", kind=OutboxKind.USAGE,
                           usage=_summary("s1")))  # 同 id 再次入队
    assert len(repo.list_all()) == 1  # 不产生重复条目


def test_sent_item_not_reverted_by_reenqueue():
    """已 sent 的条目再次 enqueue 不回退状态、不重复上报。"""
    repo = InMemoryOutboxRepository()
    repo.upsert(OutboxItem(summary_id="s1", tenant_id="t1", kind=OutboxKind.USAGE,
                           usage=_summary("s1")))
    repo.mark_sent("s1")
    repo.upsert(OutboxItem(summary_id="s1", tenant_id="t1", kind=OutboxKind.USAGE,
                           usage=_summary("s1")))
    assert repo.list_all()[0].status is OutboxStatus.SENT
    assert repo.list_pending() == []


# ---- reporter 成功/失败 ----

def test_drain_marks_sent_on_success():
    repo = InMemoryOutboxRepository()
    repo.upsert(OutboxItem(summary_id="s1", tenant_id="t1", kind=OutboxKind.USAGE,
                           usage=_summary("s1")))
    client = CapturingClient()
    result = UsageReporter(outbox=repo, client=client).drain()
    assert result.sent == 1 and result.failed == 0
    assert repo.list_pending() == []
    assert repo.list_all()[0].status is OutboxStatus.SENT
    # 写调用带 Idempotency-Key
    _, key = client.calls[0]
    assert key.startswith("uup_")


def test_drain_keeps_pending_and_retries_on_failure():
    """失败留 pending（不丢），重试后成功——不重复发已 sent 的。"""
    repo = InMemoryOutboxRepository()
    repo.upsert(OutboxItem(summary_id="s1", tenant_id="t1", kind=OutboxKind.USAGE,
                           usage=_summary("s1")))
    client = FlakyClient(fail_times=1)
    reporter = UsageReporter(outbox=repo, client=client)

    first = reporter.drain()
    assert first.failed == 1 and first.sent == 0
    item = repo.list_all()[0]
    assert item.status is OutboxStatus.PENDING  # 不丢
    assert item.attempts == 1 and item.last_error

    second = reporter.drain()  # 重试
    assert second.sent == 1
    assert repo.list_pending() == []


def test_drain_does_not_resend_already_sent():
    """二次 drain 不重复上报已 sent 的条目（不重复）。"""
    repo = InMemoryOutboxRepository()
    repo.upsert(OutboxItem(summary_id="s1", tenant_id="t1", kind=OutboxKind.USAGE,
                           usage=_summary("s1")))
    client = CapturingClient()
    reporter = UsageReporter(outbox=repo, client=client)
    reporter.drain()
    reporter.drain()  # 没有 pending 了
    assert len(client.calls) == 1  # 只上报一次


def test_drain_is_best_effort_no_raise():
    """drain 失败不抛出（尽力而为，不阻塞本地）。"""
    repo = InMemoryOutboxRepository()
    repo.upsert(OutboxItem(summary_id="s1", tenant_id="t1", kind=OutboxKind.USAGE,
                           usage=_summary("s1")))
    reporter = UsageReporter(outbox=repo, client=UnconfiguredUsageClient())
    result = reporter.drain()  # 不应抛
    assert result.failed == 1
    assert repo.list_pending()[0].status is OutboxStatus.PENDING


def test_service_end_to_end_idempotent_replay():
    """端到端：同一原始事件重复 record + flush，对端只收到一次有效上报（幂等）。"""
    client = CapturingClient()
    service = build_usage_service(client=client)
    ev = [RawUsageEvent(run_id="r1", employee_id="e1", usage={"total_tokens": 5},
                        occurred_at=datetime(2026, 6, 18, 10, 1, tzinfo=timezone.utc))]
    service.record_usage("t1", ev)
    service.flush()
    service.record_usage("t1", ev)  # 重放同一聚合域
    service.flush()
    assert len(client.calls) == 1  # 第二次无 pending，不重复上报
