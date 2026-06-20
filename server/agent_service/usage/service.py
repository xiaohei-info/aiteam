"""脱敏 usage outbox 服务编排（A5，04 §6.5 / 05 F13 / D13）。

薄编排层串起数据流：
  本地原始事件 → UsageAggregator 脱敏聚合 → OutboxRepository enqueue（pending，幂等）
  → UsageReporter.drain 上报 Manager（sent）。

红线：record_* 接收本地原始事件（可能含会话上下文），但**只把脱敏后的契约摘要**写入 outbox；
原始事件不落 outbox、不出网。flush 尽力而为，不阻塞本地执行。
"""

from __future__ import annotations

from shared.contracts.summary import AuditSummaryEvent, UsageSummary

from .aggregator import UsageAggregator
from .models import RawAuditEvent, RawUsageEvent
from .reporter import DrainResult, UsageReporter
from .store import OutboxItem, OutboxKind, OutboxRepository


class UsageService:
    """用户端脱敏 usage/审计摘要 outbox 服务。"""

    def __init__(
        self,
        *,
        outbox: OutboxRepository,
        reporter: UsageReporter,
        aggregator: UsageAggregator | None = None,
    ) -> None:
        self._outbox = outbox
        self._reporter = reporter
        self._aggregator = aggregator or UsageAggregator()

    def record_usage(self, tenant_id: str, events: list[RawUsageEvent]) -> list[UsageSummary]:
        """脱敏聚合本地 usage 原始事件并入 outbox（pending，幂等）。返回脱敏摘要。"""
        summaries = self._aggregator.aggregate_usage(tenant_id, events)
        for s in summaries:
            self._outbox.upsert(
                OutboxItem(summary_id=s.summary_id, tenant_id=s.tenant_id,
                           kind=OutboxKind.USAGE, usage=s)
            )
        return summaries

    def record_audits(
        self, tenant_id: str, events: list[RawAuditEvent]
    ) -> list[AuditSummaryEvent]:
        """脱敏审计原始事件并入 outbox（pending，幂等）。返回脱敏摘要。"""
        summaries = self._aggregator.aggregate_audits(tenant_id, events)
        for s in summaries:
            self._outbox.upsert(
                OutboxItem(summary_id=s.summary_id, tenant_id=s.tenant_id,
                           kind=OutboxKind.AUDIT, audit=s)
            )
        return summaries

    def flush(self) -> DrainResult:
        """drain outbox → 上报 Manager。尽力而为，不抛出，不阻塞本地执行。"""
        return self._reporter.drain()

    def pending(self) -> list[OutboxItem]:
        return self._outbox.list_pending()
