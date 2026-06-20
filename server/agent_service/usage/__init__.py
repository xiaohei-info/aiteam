"""用户端脱敏 usage summary outbox 上报（A5 / 04 §6.5 / 05 F13 / D13）。

数据流：本地 usage/审计原始事件 → **脱敏聚合**为 UsageSummary/AuditSummaryEvent
→ 写入 outbox（pending）→ 经窄通道按 UsageSummaryUpload 上报 Manager → sent。

铁律（D13 / CLAUDE §3.3）：会话内容、逐 token 明细、prompt/completion、provider key
**绝不上传**；脱敏在用户端**上报前**完成；上报尽力而为、不阻塞本地执行、按 summary_id 幂等。
"""

from __future__ import annotations

from .aggregator import UsageAggregator
from .client import (
    ManagerUsageClient,
    ServiceClientUsageClient,
    UnconfiguredUsageClient,
)
from .factory import build_usage_service
from .models import RawAuditEvent, RawUsageEvent
from .reporter import DrainResult, UsageReporter
from .service import UsageService
from .store import (
    InMemoryOutboxRepository,
    OutboxItem,
    OutboxKind,
    OutboxRepository,
    OutboxStatus,
)

__all__ = [
    "UsageAggregator",
    "ManagerUsageClient",
    "ServiceClientUsageClient",
    "UnconfiguredUsageClient",
    "build_usage_service",
    "RawAuditEvent",
    "RawUsageEvent",
    "DrainResult",
    "UsageReporter",
    "UsageService",
    "InMemoryOutboxRepository",
    "OutboxItem",
    "OutboxKind",
    "OutboxRepository",
    "OutboxStatus",
]
