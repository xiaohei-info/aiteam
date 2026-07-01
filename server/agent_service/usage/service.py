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
from .ledger import UsageLedger, UsageLedgerRepository, _to_cents
from .models import RawAuditEvent, RawUsageEvent, extract_cost_total, extract_token_total
from .reporter import DrainResult, UsageReporter
from .store import OutboxItem, OutboxKind, OutboxRepository



def _input_from_usage(usage: dict) -> int:
    return _coerce_int(usage.get("input_tokens")) or _coerce_int(usage.get("prompt_tokens")) or 0


def _output_from_usage(usage: dict) -> int:
    return _coerce_int(usage.get("output_tokens")) or _coerce_int(usage.get("completion_tokens")) or 0


def _coerce_int(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


import logging
_logger = logging.getLogger(__name__)

class UsageService:
    """用户端脱敏 usage/审计摘要 outbox 服务。"""

    def __init__(
        self,
        *,
        outbox: OutboxRepository,
        reporter: UsageReporter,
        aggregator: UsageAggregator | None = None,
        ledger: UsageLedgerRepository | None = None,
    ) -> None:
        self._outbox = outbox
        self._reporter = reporter
        self._aggregator = aggregator or UsageAggregator()
        self._ledger = ledger

    def record_usage(self, tenant_id: str, events: list[RawUsageEvent]) -> list[UsageSummary]:
        """脱敏聚合本地 usage 原始事件并入 outbox（pending，幂等），并落 per-run 明细账本。

        返回脱敏摘要。账本写入失败不阻断主链路（try/except + log）：账本仅用于对账观测，
        聚合上报才是主路径。
        """
        summaries = self._aggregator.aggregate_usage(tenant_id, events)
        for s in summaries:
            self._outbox.upsert(
                OutboxItem(summary_id=s.summary_id, tenant_id=s.tenant_id,
                           kind=OutboxKind.USAGE, usage=s)
            )
        if self._ledger is not None:
            self._write_usage_ledger(tenant_id, events)
        return summaries

    def _write_usage_ledger(self, tenant_id: str, events: list[RawUsageEvent]) -> None:
        """把每条原始事件写成单 run 明细行（幂等键 run_id+source_type）。"""
        for ev in events:
            try:
                cost = extract_cost_total(ev.usage)
                self._ledger.upsert(
                    UsageLedger(
                        tenant_id=tenant_id,
                        employee_id=ev.employee_id,
                        run_id=ev.run_id,
                        input_tokens=_input_from_usage(ev.usage),
                        output_tokens=_output_from_usage(ev.usage),
                        total_tokens=extract_token_total(ev.usage),
                        cost_cents=_to_cents(cost),
                        error=ev.error,
                        duration_seconds=ev.duration_seconds,
                        source_type="usage_event",
                        occurred_at=ev.occurred_at,
                    )
                )
            except Exception as exc:  # noqa: BLE001
                _logger.warning("usage ledger write failed for run %s: %s", ev.run_id, exc)

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
