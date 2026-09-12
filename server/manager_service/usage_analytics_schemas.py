"""Manager usage/work-statistics read models.

These responses expose only Manager-held aggregate usage metadata.  Conversation
entries, prompts, tool events, and work-history bodies remain Agent-local.  A
``task_count`` is nullable because Agent's current aggregate contract measures
employee executions, not independently identified business tasks.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


UsagePricingStatus = Literal["known", "partial", "unknown"]
TaskCountStatus = Literal["known", "unknown"]


class UsageStatisticsOut(BaseModel):
    """Retained Manager hourly aggregates for one tenant/member/employee scope."""

    model_config = ConfigDict(extra="forbid")

    scope: Literal["tenant"] = "tenant"
    coverage: Literal["retained_hourly_summaries"] = "retained_hourly_summaries"
    employee_id: str | None = None
    member_id: str | None = None
    window_start: datetime | None = Field(default=None, description="UTC 整点包含起点；未筛选为 null。")
    window_end: datetime | None = Field(default=None, description="UTC 整点不包含终点；未筛选为 null。")
    bucket: Literal["utc_hour"] = "utc_hour"
    summary_count: int = Field(default=0, ge=0)
    execution_count: int = Field(default=0, ge=0, description="优先使用存储的 prompt_count；旧摘要缺失时明确回退 run_count；不是独立业务任务数。")
    run_count: int = Field(default=0, ge=0, description="兼容字段，使用摘要原始 run_count；新摘要通常与 execution_count 相同。")
    succeeded_count: int = Field(default=0, ge=0, description="仅使用摘要明确提供的 settled_count。")
    non_success_count: int = Field(default=0, ge=0, description="摘要明确记录的 error_count。")
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    cache_tokens: int = Field(default=0, ge=0)
    token_total: int = Field(default=0, ge=0)
    total_tokens: int = Field(default=0, ge=0, description="兼容命名，等于 token_total。")
    token_spending: int = Field(default=0, ge=0, description="兼容命名，等于 token_total。")
    duration_ms_total: int = Field(default=0, ge=0)
    duration_seconds_total: int = Field(default=0, ge=0)
    currency: Literal["USD"] = "USD"
    cost_total: Decimal | None = Field(default=None, description="有未知价格摘要时为 null，不把未知成本当作 0。")
    total_cost: Decimal | None = Field(default=None, description="兼容命名，等于 total_spending。")
    total_spending: Decimal | None = Field(default=None, description="总费用；有未知价格摘要时为 null。")
    known_cost_total: Decimal | None = Field(default=None, ge=0, description="已知价格摘要子集的费用；没有已知价格时为 null。")
    pricing_status: UsagePricingStatus = "unknown"
    unpriced_execution_count: int = Field(default=0, ge=0)
    excluded_summary_count: int = Field(default=0, ge=0)
    task_count: int | None = Field(default=None, ge=0, description="独立业务任务数；当前 Agent 摘要未提供可靠任务事件时为 null。")
    task_count_status: TaskCountStatus = "unknown"


class UsageWorkHistoryOut(BaseModel):
    """One Manager-held hourly usage summary, not an Agent work-record body."""

    model_config = ConfigDict(extra="forbid")

    rollup_id: str
    summary_id: str
    employee_id: str | None = None
    employee_display_name: str | None = None
    member_id: str | None = None
    member_display_name: str | None = None
    window_start: datetime
    window_end: datetime
    bucket: Literal["utc_hour"] = "utc_hour"
    execution_count: int = Field(default=0, ge=0, description="优先使用存储的 prompt_count；旧摘要缺失时回退 run_count。")
    run_count: int = Field(default=0, ge=0, description="兼容的摘要原始 run_count。")
    token_total: int = Field(default=0, ge=0)
    total_tokens: int = Field(default=0, ge=0, description="兼容命名，等于 token_total。")
    token_spending: int = Field(default=0, ge=0)
    cost_total: Decimal | None = Field(default=None)
    total_cost: Decimal | None = Field(default=None, description="兼容命名，等于 total_spending。")
    total_spending: Decimal | None = Field(default=None)
    known_cost_total: Decimal | None = Field(default=None, ge=0, description="已知价格摘要费用；未知摘要不表示为零。")
    currency: Literal["USD"] = "USD"
    pricing_version: int | None = None
    pricing_status: Literal["known", "unknown"] = "unknown"
    error_count: int = Field(default=0, ge=0)
    duration_seconds_total: int = Field(default=0, ge=0)
    duration_ms_total: int = Field(default=0, ge=0)
    task_count: int | None = Field(default=None, ge=0, description="可靠任务事件缺失时为 null。")
    task_count_status: TaskCountStatus = "unknown"
    received_at: datetime | None = None


class UsageOperatorDeliveryOut(BaseModel):
    """Durable Manager -> Operator delivery receipt."""

    model_config = ConfigDict(extra="forbid")

    delivery_id: str
    summary_id: str
    enterprise_id: str | None = None
    member_id: str | None = Field(default=None, description="Agent 成员归属；旧摘要缺失时为 null。")
    employee_id: str | None = Field(default=None, description="Agent 员工归属；旧摘要缺失时为 null。")
    idempotency_key: str
    status: Literal["pending", "sending", "sent", "failed"]
    attempts: int = Field(ge=0)
    next_attempt_at: datetime | None = None
    last_error: str | None = None
    claimed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    sent_at: datetime | None = None
