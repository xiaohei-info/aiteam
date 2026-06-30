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

    return router
