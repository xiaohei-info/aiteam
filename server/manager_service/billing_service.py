"""Billing 余额查询与充值编排（B04/B09）。"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Literal
from uuid import uuid4

from shared.contracts.tenancy import TenantContext

from .billing_repository import BillingRepository


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
        return [
            {
                "recharge_id": r.recharge_id,
                "amount": r.amount,
                "payment_method": r.payment_method,
                "status": r.status,
                "order_no": r.order_no,
                "token_credited": r.token_credited,
                "created_at": r.created_at,
            }
            for r in rows
        ]

    def create_recharge(self, ctx: TenantContext, amount: Decimal, payment_method: str) -> dict:
        now = datetime.now(timezone.utc)
        order_no = f"R{now.strftime('%Y%m%d%H%M%S')}{uuid4().hex[:8]}"
        token_credited = int(amount * Decimal("1000"))
        status: Literal["pending", "success"] = "success" if payment_method == "mock_pay" else "pending"

        row = self._repo.create_recharge(
            ctx, amount=amount, payment_method=payment_method,
            status=status, order_no=order_no, token_credited=token_credited,
        )
        if status == "success":
            self._repo.upsert_balance(
                ctx, balance=amount, estimated_tokens=token_credited,
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
