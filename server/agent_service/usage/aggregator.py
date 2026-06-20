"""脱敏聚合（A5 核心，04 §6.5 / D13）。

把本地 RawUsageEvent/RawAuditEvent **脱敏聚合**为契约 UsageSummary/AuditSummaryEvent。

脱敏护栏（命门）：聚合产物**只由白名单数值/标识字段构造**，从不读取原始事件的任意透传
字段——因此即便原始事件夹带会话文本/prompt/provider key，也无路径流入摘要。

幂等键 summary_id：由 (tenant_id, employee_id, window) 确定性派生，同一聚合域反复聚合得到
同一 summary_id，配合 outbox 去重实现"上报不重复"。
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from shared.contracts.summary import AuditSummaryEvent, UsageSummary

from .models import (
    RawAuditEvent,
    RawUsageEvent,
    extract_cost_total,
    extract_token_total,
)

# 聚合窗口（默认按小时对齐）：窗口边界确定 summary_id，保证幂等。
_WINDOW = timedelta(hours=1)


def _floor_window(ts: datetime) -> tuple[datetime, datetime]:
    ts = ts.astimezone(timezone.utc)
    start = ts.replace(minute=0, second=0, microsecond=0)
    return start, start + _WINDOW


def _summary_id(tenant_id: str, employee_id: str | None, window_start: datetime) -> str:
    """确定性幂等键：同一 (tenant, employee, 窗口) 永远同一 id。"""
    raw = f"{tenant_id}|{employee_id or ''}|{window_start.isoformat()}"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]
    return f"usum_{digest}"


def _audit_id(event: RawAuditEvent, tenant_id: str) -> str:
    """审计幂等键：同一 (tenant, actor, action, resource, 时刻) 去重。"""
    raw = (
        f"{tenant_id}|{event.actor}|{event.action}"
        f"|{event.resource_type or ''}|{event.resource_id or ''}"
        f"|{event.occurred_at.astimezone(timezone.utc).isoformat()}"
    )
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]
    return f"audt_{digest}"


class UsageAggregator:
    """无状态脱敏聚合器。输入本地原始事件，输出契约摘要——只取白名单字段。"""

    def aggregate_usage(
        self, tenant_id: str, events: list[RawUsageEvent]
    ) -> list[UsageSummary]:
        """按 (employee_id, 窗口) 聚合 usage 原始事件为脱敏 UsageSummary 列表。

        只读 run_id 计数、token/cost 数值、error 标志、duration——绝不复制任何文本字段。
        """
        buckets: dict[tuple[str | None, datetime, datetime], list[RawUsageEvent]] = defaultdict(list)
        for ev in events:
            window_start, window_end = _floor_window(ev.occurred_at)
            buckets[(ev.employee_id, window_start, window_end)].append(ev)

        summaries: list[UsageSummary] = []
        for (employee_id, window_start, window_end), bucket in buckets.items():
            token_total = sum(extract_token_total(ev.usage) for ev in bucket)
            cost_total = sum(
                (extract_cost_total(ev.usage) for ev in bucket),
                start=extract_cost_total({}),  # Decimal("0") 起点，禁 float
            )
            summaries.append(
                UsageSummary(
                    summary_id=_summary_id(tenant_id, employee_id, window_start),
                    tenant_id=tenant_id,
                    employee_id=employee_id,
                    window_start=window_start,
                    window_end=window_end,
                    run_count=len(bucket),
                    token_total=token_total,
                    cost_total=cost_total,
                    error_count=sum(1 for ev in bucket if ev.error),
                    duration_seconds_total=sum(ev.duration_seconds for ev in bucket),
                )
            )
        return sorted(summaries, key=lambda s: (s.window_start, s.employee_id or ""))

    def aggregate_audits(
        self, tenant_id: str, events: list[RawAuditEvent]
    ) -> list[AuditSummaryEvent]:
        """脱敏审计摘要：只取 actor/action/resource 标识字段，不含会话内容。"""
        return [
            AuditSummaryEvent(
                summary_id=_audit_id(ev, tenant_id),
                tenant_id=tenant_id,
                actor=ev.actor,
                action=ev.action,
                resource_type=ev.resource_type,
                resource_id=ev.resource_id,
                occurred_at=ev.occurred_at,
            )
            for ev in events
        ]
