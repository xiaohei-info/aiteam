"""Billing 账户余额与充值记录的租户作用域数据访问。

新表 billing_balance / recharge_record（migration 0010）。tenant_id 只从 TenantContext 读（D22）。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from shared.db import PgTenantRouter
from shared.contracts.tenancy import TenantContext


@dataclass(frozen=True)
class BillingBalanceRow:
    balance: Decimal
    estimated_tokens: int
    warning_threshold: Decimal
    reserved_tokens: int
    updated_at: datetime


@dataclass(frozen=True)
class RechargeRecordRow:
    recharge_id: str
    amount: Decimal
    payment_method: str
    status: str
    order_no: str
    token_credited: int
    created_at: datetime


def _row_to_balance(row: Any) -> BillingBalanceRow:
    return BillingBalanceRow(
        balance=Decimal(str(row[0])), estimated_tokens=int(row[1]),
        warning_threshold=Decimal(str(row[2])), reserved_tokens=int(row[3]),
        updated_at=row[4],
    )


def _row_to_recharge(row: Any) -> RechargeRecordRow:
    return RechargeRecordRow(
        recharge_id=str(row[0]), amount=Decimal(str(row[1])),
        payment_method=row[2], status=row[3], order_no=row[4],
        token_credited=int(row[5]), created_at=row[6],
    )


class BillingRepository:
    def __init__(self, router: PgTenantRouter):
        self._router = router

    def get_balance(self, ctx: TenantContext) -> BillingBalanceRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT balance, estimated_tokens, warning_threshold, reserved_tokens, updated_at "
                "FROM billing_balance LIMIT 1",
            ).fetchone()
        if row is None:
            return BillingBalanceRow(
                balance=Decimal("0"), estimated_tokens=0,
                warning_threshold=Decimal("50"), reserved_tokens=0,
                updated_at=datetime.utcnow(),
            )
        return _row_to_balance(row)

    def upsert_balance(
        self, ctx: TenantContext, *, balance: Decimal, estimated_tokens: int,
    ) -> BillingBalanceRow:
        with self._router.session(ctx) as s:
            s.execute(
                "INSERT INTO billing_balance (tenant_id, balance, estimated_tokens) "
                "VALUES (%s, %s, %s) "
                "ON CONFLICT (tenant_id) DO UPDATE SET "
                "balance = billing_balance.balance + EXCLUDED.balance, "
                "estimated_tokens = billing_balance.estimated_tokens + EXCLUDED.estimated_tokens, "
                "updated_at = now()",
                (ctx.tenant_id, str(balance), estimated_tokens),
            )
        return self.get_balance(ctx)

    def create_recharge(
        self, ctx: TenantContext, *, amount: Decimal, payment_method: str,
        status: str, order_no: str, token_credited: int,
    ) -> RechargeRecordRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO recharge_record (tenant_id, amount, payment_method, status, order_no, token_credited) "
                "VALUES (%s, %s, %s, %s, %s, %s) "
                "RETURNING id, amount, payment_method, status, order_no, token_credited, created_at",
                (ctx.tenant_id, str(amount), payment_method, status, order_no, token_credited),
            ).fetchone()
        return _row_to_recharge(row)

    def list_recharges(self, ctx: TenantContext) -> list[RechargeRecordRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT id, amount, payment_method, status, order_no, token_credited, created_at "
                "FROM recharge_record ORDER BY created_at DESC LIMIT 200",
            ).fetchall()
        return [_row_to_recharge(r) for r in rows]
