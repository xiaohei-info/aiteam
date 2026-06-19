"""跨企业 rollup 汇总 + 平台看板编排（04 §6.5，D13）。

职责：消费 Manager 上报的**企业级脱敏聚合摘要**，落 cross_enterprise_usage_rollup，
对外提供单企业聚合视图与跨企业平台看板（全平台合计 + 各企业聚合行）。

红线（D13）：只看脱敏聚合、无会话内容、不下钻租户内部明细。本服务不持、不返回任何
成员/会话/逐 token 明细——输入是聚合 UsageSummary，输出是聚合数字。
"""

from __future__ import annotations

from decimal import Decimal

from .rollup_repository import (
    CrossEnterpriseRollupRepository,
    EnterpriseRollupRow,
)
from .rollup_schemas import (
    CrossEnterpriseBoard,
    EnterpriseRollupUpload,
    EnterpriseUsageRollup,
)


def _to_view(row: EnterpriseRollupRow) -> EnterpriseUsageRollup:
    return EnterpriseUsageRollup(
        enterprise_id=row.enterprise_id,
        tenant_id=row.tenant_id,
        run_count=row.run_count,
        token_total=row.token_total,
        cost_total=row.cost_total,
        error_count=row.error_count,
        duration_seconds_total=row.duration_seconds_total,
        summary_count=row.summary_count,
        window_start=row.window_start,
        window_end=row.window_end,
    )


class RollupService:
    """无状态编排器；依赖注入跨企业 rollup 仓储。"""

    def __init__(self, repo: CrossEnterpriseRollupRepository):
        self._repo = repo

    def ingest(self, upload: EnterpriseRollupUpload) -> None:
        """消费一次企业级上报：逐条按 summary_id 幂等累加到 cross_enterprise_usage_rollup。"""
        for summary in upload.summaries:
            self._repo.apply_summary(upload.enterprise_id, upload.tenant_id, summary)

    def enterprise_rollup(self, enterprise_id: str) -> EnterpriseUsageRollup:
        """单企业聚合视图。未知企业 → NotFound（404）。"""
        return _to_view(self._repo.get(enterprise_id))

    def cross_enterprise_board(self) -> CrossEnterpriseBoard:
        """跨企业平台看板：全平台合计 + 各企业聚合行（脱敏，无下钻）。"""
        rows = [_to_view(r) for r in self._repo.list_all()]
        return CrossEnterpriseBoard(
            enterprise_count=len(rows),
            run_count=sum(r.run_count for r in rows),
            token_total=sum(r.token_total for r in rows),
            cost_total=sum((r.cost_total for r in rows), Decimal("0")),
            error_count=sum(r.error_count for r in rows),
            duration_seconds_total=sum(r.duration_seconds_total for r in rows),
            enterprises=rows,
        )
