"""Billing 余额查询与充值编排（B04/B09）+ usage overview/records 编排。"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Literal
from uuid import uuid4

from shared.contracts.tenancy import TenantContext

from .billing_repository import BillingRepository

_ALLOWED_PAYMENT_METHODS = {"wechat_pay", "alipay", "bank_transfer"}


def _public_recharge(row) -> dict:
    legacy = row.payment_method not in _ALLOWED_PAYMENT_METHODS
    return {
        "recharge_id": row.recharge_id,
        "amount": row.amount,
        "payment_method": row.payment_method if not legacy else "bank_transfer",
        "status": row.status if not legacy else "failed",
        "order_no": row.order_no,
        "token_credited": row.token_credited if not legacy else 0,
        "created_at": row.created_at,
    }


class BillingService:
    def __init__(self, repo: BillingRepository):
        self._repo = repo

    def get_balance(self, ctx: TenantContext) -> dict:
        row = self._repo.get_balance(ctx)
        return {
            "balance": row.balance,
            "estimated_tokens": row.estimated_tokens,
            "warning_threshold": row.warning_threshold,
            "updated_at": row.updated_at,
        }

    def list_recharges(self, ctx: TenantContext) -> list[dict]:
        rows = self._repo.list_recharges(ctx)
        return [_public_recharge(row) for row in rows]

    def create_recharge(self, ctx: TenantContext, amount: Decimal, payment_method: str) -> dict:
        now = datetime.now(timezone.utc)
        order_no = f"R{now.strftime('%Y%m%d%H%M%S')}{uuid4().hex[:8]}"
        if payment_method not in {"wechat_pay", "alipay", "bank_transfer"}:
            raise ValueError("unsupported payment method")
        token_credited = int(amount * Decimal("1000"))
        status: Literal["pending"] = "pending"

        row = self._repo.create_recharge(
            ctx, amount=amount, payment_method=payment_method,
            status=status, order_no=order_no, token_credited=token_credited,
        )
        return {
            "recharge_id": row.recharge_id,
            "amount": row.amount,
            "payment_method": row.payment_method,
            "status": row.status,
            "order_no": row.order_no,
            "token_credited": row.token_credited,
            "created_at": row.created_at,
        }

    def get_usage_overview(self, ctx: TenantContext, *, period: str) -> dict:
        """按 tenant + period 聚合 usage overview（Token / USD API 成本 / 消耗最高员工 + 趋势 + 排名）。"""
        return self._repo.get_usage_overview(ctx, period=period)

    def list_usage_records(
        self, ctx: TenantContext, *, period: str, employee_id: str | None = None,
    ) -> list[dict]:
        """按 tenant + period 列 usage 明细（员工维度用量记录），可选按 employee_id 过滤。"""
        return self._repo.list_usage_records(ctx, period=period, employee_id=employee_id)
