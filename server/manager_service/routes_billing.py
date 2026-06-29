"""Manager 企业端账单与工资管理路由（B04/B09）。

边界：Manager 只持租户级用量、余额和充值记录；不接收会话内容。
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope


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
    model_config = ConfigDict(extra="forbid")

    period: str
    total_tokens: int
    total_cost: Decimal
    top_employee_id: str | None = None
    top_employee_tokens: int = 0
    trend: list[dict] = Field(default_factory=list)
    ranking: list[dict] = Field(default_factory=list)


class UsageRecordOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    record_id: str
    employee_id: str
    employee_name: str
    date: str
    input_tokens: int
    output_tokens: int
    cost: Decimal


def build_billing_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/billing", tags=["manager", "billing"])
    require = require_claims(verifier)

    @router.get("/balance", summary="查询企业余额", operation_id="manager_billing_balance")
    async def get_balance(claims: TokenClaims = Depends(require)) -> Envelope[BillingBalanceOut]:
        ctx = tenant_context_from(claims)
        now = datetime.now(timezone.utc)
        # 当前重构阶段使用租户作用域的确定性投影；真实支付/扣费由后续支付网关替换。
        return Envelope(data=BillingBalanceOut(balance=Decimal("0"), estimated_tokens=0, updated_at=now))

    @router.get("/recharges", summary="查询充值记录", operation_id="manager_billing_recharge_list")
    async def list_recharges(claims: TokenClaims = Depends(require)) -> ListEnvelope[RechargeOut]:
        tenant_context_from(claims)
        return ListEnvelope(data=[])

    @router.post("/recharges", summary="发起充值", operation_id="manager_billing_recharge_create")
    async def create_recharge(body: RechargeIn, claims: TokenClaims = Depends(require)) -> Envelope[RechargeOut]:
        tenant_context_from(claims)
        now = datetime.now(timezone.utc)
        status: Literal["pending", "success", "failed", "refunded"] = "success" if body.payment_method == "mock_pay" else "pending"
        token_credited = int(body.amount * Decimal("1000"))
        return Envelope(data=RechargeOut(
            recharge_id=str(uuid4()),
            amount=body.amount,
            payment_method=body.payment_method,
            status=status,
            order_no=f"R{now.strftime('%Y%m%d%H%M%S')}{uuid4().hex[:8]}",
            token_credited=token_credited,
            created_at=now,
        ))

    @router.get("/usage/overview", summary="工资管理用量总览", operation_id="manager_billing_usage_overview")
    async def usage_overview(
        period: Literal["month", "last_month", "all"] = Query(default="month"),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[UsageOverviewOut]:
        tenant_context_from(claims)
        return Envelope(data=UsageOverviewOut(period=period, total_tokens=0, total_cost=Decimal("0")))

    @router.get("/usage/records", summary="工资管理用量明细", operation_id="manager_billing_usage_records")
    async def usage_records(
        period: Literal["month", "last_month", "all"] = Query(default="month"),
        employee_id: str | None = None,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[UsageRecordOut]:
        tenant_context_from(claims)
        return ListEnvelope(data=[])

    return router
