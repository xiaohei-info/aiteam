"""跨企业 rollup 汇总 + 平台看板 + 治理汇总报表编排（04 §6.5，D13）。

职责：消费 Manager 上报的**企业级脱敏聚合摘要**，落 cross_enterprise_usage_rollup，
对外提供单企业聚合视图、跨企业平台看板（全平台合计 + 各企业聚合行）、以及治理汇总报表
（按时间桶聚合 / 企业排名 / 本期 vs 上期趋势）。

红线（D13）：只看脱敏聚合、无会话内容、不下钻租户内部明细。本服务不持、不返回任何
成员/会话/逐 token 明细——输入是聚合 UsageSummary，输出是聚合数字。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from decimal import Decimal

from shared.contracts.summary import UsageSummary
from shared.errors import NotFound

from .rollup_repository import (
    CrossEnterpriseRollupRepository,
    EnterpriseRollupRow,
)
from .rollup_schemas import (
    AggregationPeriod,
    CrossEnterpriseBoard,
    EnterpriseRankRow,
    EnterpriseRollupUpload,
    EnterpriseTrend,
    EnterpriseUsageRollup,
    RollupMetric,
    RollupReport,
    TimeBucket,
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


def _period_label(dt: datetime, period: AggregationPeriod) -> str:
    """将时间点映射到日/周/月桶标签。"""
    if period == AggregationPeriod.DAY:
        return dt.strftime("%Y-%m-%d")
    if period == AggregationPeriod.WEEK:
        iso_year, iso_week, _ = dt.isocalendar()
        return f"{iso_year}-W{iso_week:02d}"
    # MONTH
    return dt.strftime("%Y-%m")


def _metric_value(s: UsageSummary, metric: RollupMetric) -> int | Decimal:
    if metric == RollupMetric.RUN_COUNT:
        return s.run_count
    if metric == RollupMetric.TOKEN_TOTAL:
        return s.token_total
    if metric == RollupMetric.COST_TOTAL:
        return s.cost_total
    if metric == RollupMetric.ERROR_COUNT:
        return s.error_count
    return s.duration_seconds_total


def _metric_value_from_map(m: dict, metric: RollupMetric) -> int | Decimal:
    if metric == RollupMetric.RUN_COUNT:
        return m["run_count"]
    if metric == RollupMetric.TOKEN_TOTAL:
        return m["token_total"]
    if metric == RollupMetric.COST_TOTAL:
        return m["cost_total"]
    if metric == RollupMetric.ERROR_COUNT:
        return m["error_count"]
    return m["duration_seconds_total"]


def _zero_metric(metric: RollupMetric) -> int | Decimal:
    return Decimal("0") if metric == RollupMetric.COST_TOTAL else 0


class RollupService:
    """无状态编排器；依赖注入跨企业 rollup 仓储。"""

    def __init__(self, repo: CrossEnterpriseRollupRepository):
        self._repo = repo

    def ingest(self, upload: EnterpriseRollupUpload) -> None:
        """消费一次企业级上报：逐条按 summary_id 幂等累加到 cross_enterprise_usage_rollup。"""
        for summary in upload.summaries:
            self._repo.apply_summary(upload.enterprise_id, upload.tenant_id, summary)

    def enterprise_rollup(self, enterprise_id: str) -> EnterpriseUsageRollup:
        """单企业聚合视图。未知企业 → 全零聚合（run_count=0, token_total=0 等，GH#328）。"""
        try:
            row = self._repo.get(enterprise_id)
        except NotFound:
            row = None
        if row is None:
            return EnterpriseUsageRollup(enterprise_id=enterprise_id, tenant_id="")
        return _to_view(row)

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

    # ---- 治理汇总报表：时间桶聚合 / 排名 / 趋势 ----

    def report(
        self,
        *,
        period: AggregationPeriod,
        metric: RollupMetric,
        window: tuple[datetime, datetime] | None = None,
    ) -> RollupReport:
        """治理汇总报表：按时间桶聚合 + 企业排名 + 本期 vs 上期趋势。

        window 为本期时间窗口 (start, end)；未传入时由已入库摘要的窗口包络决定。
        上期自动取等长前移窗口（[start - span, start)）。
        """
        all_pairs = self._repo.all_summaries()
        if not all_pairs:
            return RollupReport(
                period=period.value,
                metric=metric.value,
                window_start=None,
                window_end=None,
                totals=TimeBucket(period_label="total"),
                buckets=[],
                ranking=[],
                trends=[],
            )

        if window is None:
            start = min(s.window_start for _, s in all_pairs)
            end = max(s.window_end for _, s in all_pairs)
        else:
            start, end = window
        span = end - start
        prev_start = start - span
        prev_end = start

        cur_pairs = [(eid, s) for eid, s in all_pairs if start <= s.window_start < end]
        prev_pairs = [(eid, s) for eid, s in all_pairs if prev_start <= s.window_start < prev_end]

        buckets = self._time_buckets(cur_pairs, period)
        totals = self._aggregate_totals(cur_pairs)
        totals.period_label = "total"
        ranking = self._rank_enterprises(cur_pairs, metric)
        trends = self._enterprise_trends(cur_pairs, prev_pairs, metric)

        return RollupReport(
            period=period.value,
            metric=metric.value,
            window_start=start,
            window_end=end,
            totals=totals,
            buckets=buckets,
            ranking=ranking,
            trends=trends,
        )

    def _time_buckets(
        self, pairs: list[tuple[str, UsageSummary]], period: AggregationPeriod
    ) -> list[TimeBucket]:
        """按时间桶聚合（日/周/月），桶内累加所有脱敏摘要。"""
        grouped: dict[str, list[UsageSummary]] = defaultdict(list)
        for _, s in pairs:
            grouped[_period_label(s.window_start, period)].append(s)

        buckets: list[TimeBucket] = []
        for label in sorted(grouped):
            items = grouped[label]
            buckets.append(TimeBucket(
                period_label=label,
                run_count=sum(s.run_count for s in items),
                token_total=sum(s.token_total for s in items),
                cost_total=sum((s.cost_total for s in items), Decimal("0")),
                error_count=sum(s.error_count for s in items),
                duration_seconds_total=sum(s.duration_seconds_total for s in items),
                summary_count=len(items),
            ))
        return buckets

    def _aggregate_totals(self, pairs: list[tuple[str, UsageSummary]]) -> TimeBucket:
        items = [s for _, s in pairs]
        return TimeBucket(
            period_label="total",
            run_count=sum(s.run_count for s in items),
            token_total=sum(s.token_total for s in items),
            cost_total=sum((s.cost_total for s in items), Decimal("0")),
            error_count=sum(s.error_count for s in items),
            duration_seconds_total=sum(s.duration_seconds_total for s in items),
            summary_count=len(items),
        )

    def _rank_enterprises(
        self, pairs: list[tuple[str, UsageSummary]], metric: RollupMetric
    ) -> list[EnterpriseRankRow]:
        """按指定指标降序排名。"""
        agg: dict[str, dict] = {}
        for eid, s in pairs:
            if eid not in agg:
                agg[eid] = {
                    "enterprise_id": eid,
                    "tenant_id": s.tenant_id,
                    "run_count": 0,
                    "token_total": 0,
                    "cost_total": Decimal("0"),
                    "error_count": 0,
                    "duration_seconds_total": 0,
                }
            a = agg[eid]
            a["run_count"] += s.run_count
            a["token_total"] += s.token_total
            a["cost_total"] += s.cost_total
            a["error_count"] += s.error_count
            a["duration_seconds_total"] += s.duration_seconds_total

        rows = sorted(agg.values(), key=lambda a: _metric_value_from_map(a, metric), reverse=True)
        return [
            EnterpriseRankRow(
                rank=i + 1,
                enterprise_id=a["enterprise_id"],
                tenant_id=a["tenant_id"],
                run_count=a["run_count"],
                token_total=a["token_total"],
                cost_total=a["cost_total"],
                error_count=a["error_count"],
                duration_seconds_total=a["duration_seconds_total"],
                metric_value=_metric_value_from_map(a, metric),
            )
            for i, a in enumerate(rows)
        ]

    def _enterprise_trends(
        self,
        cur_pairs: list[tuple[str, UsageSummary]],
        prev_pairs: list[tuple[str, UsageSummary]],
        metric: RollupMetric,
    ) -> list[EnterpriseTrend]:
        """本期 vs 上期趋势（等长前移窗口）。"""
        cur: dict[str, tuple[str, int | Decimal]] = {}
        for eid, s in cur_pairs:
            tid, val = cur.get(eid, (s.tenant_id, _zero_metric(metric)))
            cur[eid] = (tid, val + _metric_value(s, metric))

        prev: dict[str, tuple[str, int | Decimal]] = {}
        for eid, s in prev_pairs:
            tid, val = prev.get(eid, (s.tenant_id, _zero_metric(metric)))
            prev[eid] = (tid, val + _metric_value(s, metric))

        trends: list[EnterpriseTrend] = []
        for eid in cur:
            tid, cur_val = cur[eid]
            prev_val = prev[eid][1] if eid in prev else _zero_metric(metric)
            if prev_val == 0:
                growth = None
            else:
                growth = float((cur_val - prev_val) / prev_val) * 100
            trends.append(EnterpriseTrend(
                enterprise_id=eid,
                tenant_id=tid,
                current=cur_val,
                previous=prev_val,
                growth_pct=growth,
            ))
        trends.sort(key=lambda t: t.enterprise_id)
        return trends
