"""Manager 企业端账单与工资管理路由（B04/B09）。

边界：Manager 只持租户级用量、余额和充值记录；不接收会话内容。
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import authorize, require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .billing_repository import BillingRepository
from .billing_service import BillingService


class BillingBalanceOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    balance: Decimal = Decimal("0")
    estimated_tokens: int = 0
    warning_threshold: Decimal = Decimal("50")
    updated_at: datetime


class RechargeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    amount: Decimal = Field(gt=0)
    payment_method: Literal["wechat_pay", "alipay", "bank_transfer"]


class RechargeOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    recharge_id: str
    amount: Decimal
    payment_method: Literal["wechat_pay", "alipay", "bank_transfer"]
    status: Literal["pending", "success", "failed", "refunded"]
    order_no: str
    token_credited: int
    created_at: datetime


class UsageOverviewOut(BaseModel):
    """用量总览出参（兼容前端字段，保留未知归属/价格摘要）。"""
    model_config = ConfigDict(extra="forbid")
    period: str
    total_tokens: int
    total_cost: Decimal | None
    known_cost_total: Decimal | None = None
    total_spending: Decimal | None = None
    pricing_status: Literal["known", "partial", "unknown"] = "unknown"
    summary_count: int = Field(default=0, ge=0)
    execution_count: int = Field(default=0, description="优先使用摘要 prompt_count；旧摘要缺失时回退 run_count，不是独立业务任务数。")
    run_count: int = Field(default=0, description="兼容的摘要原始 run_count。")
    unknown_pricing_tokens: int = 0
    unknown_pricing_runs: int = 0
    top_employee_id: str | None = None
    top_employee_tokens: int = 0
    trend: list[dict[str, Any]] = Field(default_factory=list, description="按 UTC 日排序的用量趋势；不制造分钟级 totals。")
    ranking: list[dict[str, Any]] = Field(default_factory=list, description="员工用量排名；不含无法归属员工的排名项。")
    employee_id: str | None = Field(default=None, description="可选员工过滤。")
    member_id: str | None = Field(default=None, description="可选成员过滤；旧摘要缺失时为 null。")
    task_count: int | None = Field(default=None, description="独立业务任务数；无可靠任务事件时为 null。")
    task_count_status: Literal["known", "unknown"] = "unknown"


class UsageRecordOut(BaseModel):
    """员工/成员维度小时用量明细（不包含会话或工具正文）。"""
    model_config = ConfigDict(extra="forbid")
    record_id: str
    employee_id: str | None = None
    employee_name: str
    member_id: str | None = None
    member_name: str | None = None
    date: str | None = None
    window_start: datetime | None = None
    window_end: datetime | None = None
    token_total: int
    total_tokens: int | None = None
    token_spending: int | None = None
    cost: Decimal | None = None
    total_cost: Decimal | None = None
    total_spending: Decimal | None = None
    run_count: int = 0
    execution_count: int = Field(default=0, description="优先使用摘要 prompt_count；旧摘要缺失时回退 run_count，不是独立业务任务数。")
    task_count: int | None = Field(default=None, description="无可靠任务事件时为 null。")
    task_count_status: Literal["known", "unknown"] = "unknown"
    pricing_status: Literal["known", "unknown"] = "unknown"


_BILLING_ROLES = ["owner", "finance_admin"]


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> BillingService:
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_billing_service", None)
    if cache is None:
        cache = BillingService(BillingRepository(PgTenantRouter(dsn)))
        request.app.state._billing_service = cache
    return cache


def build_billing_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/billing", tags=["manager", "billing"])
    require = require_claims(verifier)

    @router.get("/balance", summary="查询企业余额（owner/finance_admin）", operation_id="manager_billing_balance")
    async def get_balance(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[BillingBalanceOut]:
        authorize(claims, _BILLING_ROLES)
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.get_balance(ctx)
        return Envelope(data=BillingBalanceOut(**data))

    @router.get("/recharges", summary="查询充值记录（owner/finance_admin）", operation_id="manager_billing_recharge_list")
    async def list_recharges(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[RechargeOut]:
        authorize(claims, _BILLING_ROLES)
        ctx = tenant_context_from(claims)
        svc = _service(request)
        items = svc.list_recharges(ctx)
        return ListEnvelope(data=[RechargeOut(**r) for r in items])

    @router.post("/recharges", summary="发起充值（owner/finance_admin）", operation_id="manager_billing_recharge_create")
    async def create_recharge(
        body: RechargeIn,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[RechargeOut]:
        authorize(claims, _BILLING_ROLES)
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.create_recharge(ctx, body.amount, body.payment_method)
        return Envelope(data=RechargeOut(**data))

    @router.get("/usage/overview", summary="查询用量总览（owner/finance_admin）", operation_id="manager_billing_usage_overview")
    async def get_usage_overview(
        request: Request,
        period: str = Query(default="month", description="统计周期：month / last_month / all"),
        employee_id: str | None = Query(default=None, description="可选员工 ID 过滤。"),
        member_id: str | None = Query(default=None, description="可选成员 ID 过滤。"),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[UsageOverviewOut]:
        authorize(claims, _BILLING_ROLES)
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.get_usage_overview(
            ctx, period=period, employee_id=employee_id, member_id=member_id,
        )
        data.setdefault("employee_id", employee_id)
        data.setdefault("member_id", member_id)
        unknown_pricing = bool(data.get("unknown_pricing_tokens") or data.get("unknown_pricing_runs"))
        data.setdefault("total_spending", None if unknown_pricing else data.get("total_cost"))
        data.setdefault("known_cost_total", None if unknown_pricing else data.get("total_cost"))
        data.setdefault("pricing_status", "unknown" if unknown_pricing else "known")
        return Envelope(data=UsageOverviewOut(**data))

    @router.get("/usage/records", summary="查询员工用量明细（owner/finance_admin）", operation_id="manager_billing_usage_records")
    async def list_usage_records(
        request: Request,
        period: str = Query(default="month", description="统计周期：month / last_month / all"),
        employee_id: str | None = Query(default=None, description="可选员工 id 过滤"),
        member_id: str | None = Query(default=None, description="可选成员 id 过滤"),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[UsageRecordOut]:
        authorize(claims, _BILLING_ROLES)
        ctx = tenant_context_from(claims)
        svc = _service(request)
        items = svc.list_usage_records(
            ctx, period=period, employee_id=employee_id, member_id=member_id,
        )
        return ListEnvelope(data=[UsageRecordOut(**r) for r in items])

    return router
