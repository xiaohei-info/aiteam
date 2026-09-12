"""治理汇总报表聚合单测（04 §6.5，D13）。

覆盖：日/周/月时间桶聚合、口径一致性（桶合计 == 全平台合计）、企业排名（多指标）、
本期 vs 上期趋势（增长/下降/无基线）、红线（响应无会话/成员/明细字段）。
"""

from datetime import datetime
from decimal import Decimal

import pytest

from operation_service.rollup_repository import CrossEnterpriseRollupRepository
from operation_service.rollup_schemas import EnterpriseRollupUpload, RollupMetric, AggregationPeriod
from operation_service.rollup_service import RollupService


def _summary(summary_id: str, tenant: str, window_start: datetime, window_end: datetime, **kw) -> dict:
    base = dict(
        summary_id=summary_id,
        tenant_id=tenant,
        window_start=window_start,
        window_end=window_end,
        run_count=1,
        token_total=100,
        cost_total=Decimal("1.50"),
        pricing_status="known",
        error_count=0,
        duration_seconds_total=10,
    )
    base.update(kw)
    return base


def _svc_with_data() -> RollupService:
    svc = RollupService(CrossEnterpriseRollupRepository())
    # ent-a: 跨 3 天 (6/1, 6/2, 6/3)，不同 token
    svc.ingest(EnterpriseRollupUpload(enterprise_id="ent-a", tenant_id="t-a", summaries=[
        _summary("a1", "t-a", datetime(2026, 6, 1), datetime(2026, 6, 2), token_total=100, run_count=1, cost_total=Decimal("1.0")),
        _summary("a2", "t-a", datetime(2026, 6, 2), datetime(2026, 6, 3), token_total=50, run_count=2, cost_total=Decimal("2.0"), error_count=1),
        _summary("a3", "t-a", datetime(2026, 6, 3), datetime(2026, 6, 4), token_total=200, run_count=3, cost_total=Decimal("3.0")),
    ]))
    # ent-b: 同样 3 天
    svc.ingest(EnterpriseRollupUpload(enterprise_id="ent-b", tenant_id="t-b", summaries=[
        _summary("b1", "t-b", datetime(2026, 6, 1), datetime(2026, 6, 2), token_total=300, run_count=5, cost_total=Decimal("4.0")),
        _summary("b2", "t-b", datetime(2026, 6, 2), datetime(2026, 6, 3), token_total=150, run_count=1, cost_total=Decimal("1.0")),
        _summary("b3", "t-b", datetime(2026, 6, 3), datetime(2026, 6, 4), token_total=50, run_count=1, cost_total=Decimal("1.0"), error_count=2),
    ]))
    return svc


def test_daily_buckets_aggregate_and_align_with_totals():
    svc = _svc_with_data()
    rep = svc.report(period=AggregationPeriod.DAY, metric=RollupMetric.TOKEN_TOTAL)
    assert rep.period == "day"
    assert len(rep.buckets) == 3
    # 口径一致：桶合计 == 全平台 totals
    assert rep.totals.token_total == sum(b.token_total for b in rep.buckets)
    # 日桶 6/1: a1(100) + b1(300) = 400
    assert rep.buckets[0].period_label == "2026-06-01"
    assert rep.buckets[0].token_total == 400


def test_weekly_buckets_group_days_into_weeks():
    svc = _svc_with_data()
    rep = svc.report(period=AggregationPeriod.WEEK, metric=RollupMetric.TOKEN_TOTAL)
    assert rep.period == "week"
    # 2026-06-01 ~ 2026-06-03 都在同一 ISO 周
    assert len(rep.buckets) == 1
    assert rep.totals.token_total == 850  # 100+50+200 + 300+150+50


def test_ranking_by_token_total_descending():
    svc = _svc_with_data()
    rep = svc.report(period=AggregationPeriod.DAY, metric=RollupMetric.TOKEN_TOTAL)
    # ent-a token=350, ent-b token=500 → ent-b 第一
    assert [r.enterprise_id for r in rep.ranking] == ["ent-b", "ent-a"]
    assert rep.ranking[0].rank == 1
    assert rep.ranking[0].metric_value == 500
    assert rep.ranking[1].metric_value == 350


def test_ranking_by_run_count_metric():
    svc = _svc_with_data()
    rep = svc.report(period=AggregationPeriod.DAY, metric=RollupMetric.RUN_COUNT)
    # ent-a runs=1+2+3=6, ent-b runs=5+1+1=7 → ent-b 第一
    assert rep.ranking[0].enterprise_id == "ent-b"
    assert rep.ranking[0].metric_value == 7


def test_trend_growth_and_decline():
    """本期 vs 上期（等长前移窗口）：ent-a 在本期有数据、上期无数据 → growth=None。"""
    svc = RollupService(CrossEnterpriseRollupRepository())
    svc.ingest(EnterpriseRollupUpload(enterprise_id="ent-a", tenant_id="t-a", summaries=[
        _summary("c1", "t-a", datetime(2026, 6, 10), datetime(2026, 6, 11), token_total=100),   # 本期
        _summary("c2", "t-a", datetime(2026, 6, 9), datetime(2026, 6, 10), token_total=50),     # 上期 (prev window)
    ]))
    # 窗口 (6/10,6/11) span=1d → 上期窗口 [6/9,6/10)
    rep = svc.report(
        period=AggregationPeriod.DAY,
        metric=RollupMetric.TOKEN_TOTAL,
        window=(datetime(2026, 6, 10), datetime(2026, 6, 11)),
    )
    trend = next(t for t in rep.trends if t.enterprise_id == "ent-a")
    # 本期 100 vs 上期 50 → 增长 100%
    assert trend.current == 100
    assert trend.previous == 50
    assert trend.growth_pct == pytest.approx(100.0)


def test_trend_no_previous_baseline_is_none():
    svc = RollupService(CrossEnterpriseRollupRepository())
    svc.ingest(EnterpriseRollupUpload(enterprise_id="ent-a", tenant_id="t-a", summaries=[
        _summary("d1", "t-a", datetime(2026, 6, 10), datetime(2026, 6, 11), token_total=100),
    ]))
    rep = svc.report(
        period=AggregationPeriod.DAY,
        metric=RollupMetric.TOKEN_TOTAL,
        window=(datetime(2026, 6, 10), datetime(2026, 6, 12)),
    )
    trend = rep.trends[0]
    assert trend.current == 100
    assert trend.previous == 0
    assert trend.growth_pct is None


def test_empty_repo_report_is_zeroed():
    svc = RollupService(CrossEnterpriseRollupRepository())
    rep = svc.report(period=AggregationPeriod.DAY, metric=RollupMetric.TOKEN_TOTAL)
    assert rep.totals.token_total == 0
    assert rep.buckets == []
    assert rep.ranking == []
    assert rep.trends == []
    assert rep.window_start is None


def test_cost_report_ignores_unknown_pricing_and_preserves_null_when_unpriced():
    svc = RollupService(CrossEnterpriseRollupRepository())
    svc.ingest(EnterpriseRollupUpload(enterprise_id="known", tenant_id="t-known", summaries=[
        _summary("known-cost", "t-known", datetime(2026, 6, 1), datetime(2026, 6, 2), cost_total=Decimal("2.50")),
    ]))
    svc.ingest(EnterpriseRollupUpload(enterprise_id="unknown", tenant_id="t-unknown", summaries=[
        _summary("unknown-cost", "t-unknown", datetime(2026, 6, 1), datetime(2026, 6, 2), cost_total=None, pricing_status="unknown"),
    ]))

    report = svc.report(period=AggregationPeriod.DAY, metric=RollupMetric.COST_TOTAL)
    assert report.totals.cost_total == Decimal("2.50")
    assert report.buckets[0].cost_total == Decimal("2.50")
    assert [row.enterprise_id for row in report.ranking] == ["known", "unknown"]
    assert report.ranking[0].metric_value == Decimal("2.50")
    assert report.ranking[1].metric_value is None

    unknown_report = RollupService(CrossEnterpriseRollupRepository())
    unknown_report.ingest(EnterpriseRollupUpload(enterprise_id="unknown", tenant_id="t-unknown", summaries=[
        _summary("unknown-only", "t-unknown", datetime(2026, 6, 1), datetime(2026, 6, 2), cost_total=None, pricing_status="unknown"),
    ]))
    empty_cost = unknown_report.report(period=AggregationPeriod.DAY, metric=RollupMetric.COST_TOTAL)
    assert empty_cost.totals.cost_total is None
    assert empty_cost.buckets[0].cost_total is None
    assert empty_cost.ranking[0].metric_value is None


def test_report_only_exposes_aggregated_fields():
    """红线（D13）：报表行/桶只暴露聚合数字，无会话/成员/明细字段。"""
    svc = _svc_with_data()
    rep = svc.report(period=AggregationPeriod.DAY, metric=RollupMetric.TOKEN_TOTAL)
    dumped = rep.model_dump()
    for row in dumped["ranking"]:
        assert set(row).issubset({
            "rank", "enterprise_id", "tenant_id", "run_count", "token_total",
            "cost_total", "error_count", "duration_seconds_total", "metric_value",
        })
    for bucket in dumped["buckets"]:
        assert set(bucket).issubset({
            "period_label", "run_count", "token_total", "cost_total",
            "error_count", "duration_seconds_total", "summary_count",
        })
