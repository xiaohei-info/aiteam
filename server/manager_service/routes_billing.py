"""Manager 企业端账单与工资管理路由（B04/B09）。

边界：Manager 只持租户级用量、余额和充值记录；不接收会话内容。
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import require_claims, tenant_context_from
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
    payment_method: Literal["wechat_pay", "alipay", "bank_transfer", "mock_pay"]


class RechargeOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    recharge_id: str
    amount: Decimal
    payment_method: str
    status: Literal["pending", "success", "failed", "refunded"]
    order_no: str
    token_credited: int
    created_at: datetime


class UsageOverviewOut(BaseModel):
    """用量总览出参（对齐前端 UsageOverview 契约）。"""
    model_config = ConfigDict(extra="forbid")
    period: str
    total_tokens: int
    total_cost: Decimal
    top_employee_id: str | None = None
    top_employee_tokens: int = 0
    trend: list[dict] = Field(default_factory=list)
    ranking: list[dict] = Field(default_factory=list)


class UsageRecordOut(BaseModel):
    """员工维度用量明细出参（对齐前端 UsageRecord 契约）。"""
    model_config = ConfigDict(extra="forbid")
    record_id: str
    employee_id: str
    employee_name: str
    date: str | None = None
    input_tokens: int
    output_tokens: int
    cost: Decimal


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

    @router.get("/balance", summary="查询企业余额", operation_id="manager_billing_balance")
    async def get_balance(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[BillingBalanceOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.get_balance(ctx)
        return Envelope(data=BillingBalanceOut(**data))

    @router.get("/recharges", summary="查询充值记录", operation_id="manager_billing_recharge_list")
    async def list_recharges(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[RechargeOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        items = svc.list_recharges(ctx)
        return ListEnvelope(data=[RechargeOut(**r) for r in items])

    @router.post("/recharges", summary="发起充值", operation_id="manager_billing_recharge_create")
    async def create_recharge(
        body: RechargeIn,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[RechargeOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.create_recharge(ctx, body.amount, body.payment_method)
        return Envelope(data=RechargeOut(**data))

    @router.get("/usage/overview", summary="查询用量总览", operation_id="manager_billing_usage_overview")
    async def get_usage_overview(
        request: Request,
        period: str = Query(default="month", description="统计周期：month / last_month / all"),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[UsageOverviewOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.get_usage_overview(ctx, period=period)
        return Envelope(data=UsageOverviewOut(**data))

    @router.get("/usage/records", summary="查询员工用量明细", operation_id="manager_billing_usage_records")
    async def list_usage_records(
        request: Request,
        period: str = Query(default="month", description="统计周期：month / last_month / all"),
        employee_id: str | None = Query(default=None, description="可选员工 id 过滤"),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[UsageRecordOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        items = svc.list_usage_records(ctx, period=period, employee_id=employee_id)
        return ListEnvelope(data=[UsageRecordOut(**r) for r in items])

    return router
