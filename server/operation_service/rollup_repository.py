"""运营端跨企业 rollup 仓储（cross_enterprise_usage_rollup，oper 库骨架）。

单写者：cross_enterprise_usage_rollup 唯一写端是 Operator（CLAUDE/AGENTS §3.2）。
只持**企业级脱敏聚合数字** + 已见 summary_id（幂等去重），绝不持成员/会话/token 明细（D13）。

骨架期用进程内存实现；详设接 PostgreSQL（oper 库），接口形状不变。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from shared.contracts.summary import UsageSummary
from shared.errors import NotFound


@dataclass
class EnterpriseRollupRow:
    """单企业累加器。只存聚合标量；seen_ids 仅用于幂等，不含任何明细内容。"""

    enterprise_id: str
    tenant_id: str
    run_count: int = 0
    token_total: int = 0
    cost_total: Decimal = field(default_factory=lambda: Decimal("0"))
    error_count: int = 0
    duration_seconds_total: int = 0
    summary_count: int = 0
    window_start: datetime | None = None
    window_end: datetime | None = None
    _seen_ids: set[str] = field(default_factory=set)

    def apply(self, s: UsageSummary) -> bool:
        """累加一条脱敏摘要；已见 summary_id 直接跳过。返回是否真正计入。"""
        if s.summary_id in self._seen_ids:
            return False
        self._seen_ids.add(s.summary_id)
        self.run_count += s.run_count
        self.token_total += s.token_total
        self.cost_total += s.cost_total
        self.error_count += s.error_count
        self.duration_seconds_total += s.duration_seconds_total
        self.summary_count += 1
        if self.window_start is None or s.window_start < self.window_start:
            self.window_start = s.window_start
        if self.window_end is None or s.window_end > self.window_end:
            self.window_end = s.window_end
        return True


class CrossEnterpriseRollupRepository:
    """跨企业 rollup 的进程内仓储。每企业一行累加器，幂等去重在行内完成。"""

    def __init__(self) -> None:
        self._rows: dict[str, EnterpriseRollupRow] = {}

    def apply_summary(self, enterprise_id: str, tenant_id: str, summary: UsageSummary) -> None:
        row = self._rows.get(enterprise_id)
        if row is None:
            row = EnterpriseRollupRow(enterprise_id=enterprise_id, tenant_id=tenant_id)
            self._rows[enterprise_id] = row
        row.apply(summary)

    def get(self, enterprise_id: str) -> EnterpriseRollupRow:
        row = self._rows.get(enterprise_id)
        if row is None:
            raise NotFound(f"enterprise rollup not found: {enterprise_id}")
        return row

    def list_all(self) -> list[EnterpriseRollupRow]:
        return list(self._rows.values())
