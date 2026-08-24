"""运营端跨企业 rollup 北向 API 边界 schema（04 §6.5，D13）。

只声明本端 HTTP 请求/响应形状。**聚合单元一律复用 shared.contracts.summary.UsageSummary**，
禁在此重定义计量字段（task 红线 + contracts §1 防跑偏铁律）。

红线（04 §6.5 / D13）：Operator 只消费**脱敏聚合摘要**——无会话内容、无 token 明细、
不下钻租户内部明细。本 schema 的请求/响应只承载企业级与跨企业级聚合数字。
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.crosstier import EnterpriseRollupUpload
from shared.contracts.summary import UsageSummary


class EnterpriseUsageRollup(BaseModel):
    """单企业聚合视图（平台看板的一行）。只含脱敏聚合数字，不下钻成员/会话明细。"""

    model_config = ConfigDict(extra="forbid")

    enterprise_id: str
    tenant_id: str
    run_count: int = 0
    token_total: int = 0
    cost_total: Decimal = Field(default=Decimal("0"))
    error_count: int = 0
    duration_seconds_total: int = 0
    summary_count: int = Field(default=0, description="已聚合的脱敏摘要条数")
    window_start: datetime | None = Field(default=None, description="覆盖窗口最早起点")
    window_end: datetime | None = Field(default=None, description="覆盖窗口最晚终点")


class CrossEnterpriseBoard(BaseModel):
    """跨企业平台看板（cross_enterprise_usage_rollup 视图）。

    顶部为全平台合计，下挂各企业聚合行。全程脱敏聚合，无租户内部明细下钻（D13 红线）。
    """

    model_config = ConfigDict(extra="forbid")

    enterprise_count: int = 0
    run_count: int = 0
    token_total: int = 0
    cost_total: Decimal = Field(default=Decimal("0"))
    error_count: int = 0
    duration_seconds_total: int = 0
    enterprises: list[EnterpriseUsageRollup] = Field(default_factory=list)


# ---- 治理汇总报表（聚合 / 排名 / 趋势）schema ----

from enum import Enum


class AggregationPeriod(Enum):
    """聚合时间粒度。"""
    DAY = "day"
    WEEK = "week"
    MONTH = "month"


class RollupMetric(Enum):
    """可排名/趋势化的聚合指标。"""
    RUN_COUNT = "run_count"
    TOKEN_TOTAL = "token_total"
    COST_TOTAL = "cost_total"
    ERROR_COUNT = "error_count"
    DURATION_SECONDS = "duration_seconds_total"


class TimeBucket(BaseModel):
    """单时间桶聚合。period_label 形式：日 2026-06-01、周 2026-W23、月 2026-06。"""

    model_config = ConfigDict(extra="forbid")

    period_label: str = Field(description="时间桶标签（日/周/月）")
    run_count: int = 0
    token_total: int = 0
    cost_total: Decimal = Field(default=Decimal("0"))
    error_count: int = 0
    duration_seconds_total: int = 0
    summary_count: int = 0


class EnterpriseRankRow(BaseModel):
    """企业排名行（按 metric 降序）。metric_value 即为排序指标当前值。"""

    model_config = ConfigDict(extra="forbid")

    rank: int
    enterprise_id: str
    tenant_id: str
    run_count: int
    token_total: int
    cost_total: Decimal
    error_count: int
    duration_seconds_total: int
    metric_value: int | Decimal = Field(description="排序指标本期值（与 metric 对应）")


class EnterpriseTrend(BaseModel):
    """单企业本期 vs 上期趋势。growth_pct 为百分比；上期 0 → None（无基线）。"""

    model_config = ConfigDict(extra="forbid")

    enterprise_id: str
    tenant_id: str
    current: int | Decimal
    previous: int | Decimal
    growth_pct: float | None = Field(description="增长率(%)；上期 0 时为 None")


class RollupReport(BaseModel):
    """Rollup 治理汇总报表：聚合口径由 period/metric 决定（04 §6.5，D13 红线）。"""

    model_config = ConfigDict(extra="forbid")

    period: str = Field(description="聚合粒度：day | week | month")
    metric: str = Field(description="排名/趋势指标：run_count|token_total|cost_total|error_count|duration_seconds_total")
    window_start: datetime | None = None
    window_end: datetime | None = None
    totals: TimeBucket = Field(description="本期全平台合计")
    buckets: list[TimeBucket] = Field(description="按时间桶聚合序列（按 period_label 升序）")
    ranking: list[EnterpriseRankRow] = Field(description="企业排名（按 metric 降序）")
    trends: list[EnterpriseTrend] = Field(description="各企业本期 vs 上期趋势")
