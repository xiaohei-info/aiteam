"""Billing 账户余额与充值记录的租户作用域数据访问。

新表 billing_balance / recharge_record（migration 0010）。tenant_id 只从 TenantContext 读（D22）。
本模块同时承载 usage overview / records 的聚合查询（复用 usage_rollup / usage_ledger 的脱敏聚合数据）。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
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


def _period_to_window(period: str) -> tuple[datetime | None, datetime | None]:
    """将前端 period 参数（month / last_month / all）转换为 (window_start, window_end)。

    None 端表示无边界（all 时两端都为 None）。时区对齐 UTC，与 usage_rollup / usage_ledger 一致。
    """
    now = datetime.now(timezone.utc)
    if period == "month":
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return start, None
    if period == "last_month":
        first_of_this = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        last_day_prev = first_of_this - timedelta(days=1)
        start = last_day_prev.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        end = first_of_this
        return start, end
    if period == "all":
        return None, None
    # 未知 period 视为 month（与前端默认值对齐）
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return start, None


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

    # ---- usage overview / records：复用 usage_rollup / usage_ledger 的脱敏聚合数据 ----

    def get_usage_overview(
        self, ctx: TenantContext, *, period: str,
    ) -> dict:
        """按 tenant + period 窗口聚合 usage overview（总消耗 Token / 折合费用 / 消耗最高员工 + 趋势 + 排名）。

        数据源：usage_rollup（脱敏聚合摘要，对齐 shared.contracts.summary.UsageSummary）。
        tenant_id 全程经 TenantContext（D22）；跨租户因 RLS 不可见。
        """
        window_start, window_end = _period_to_window(period)
        ws = window_start
        we = window_end
        with self._router.session(ctx) as s:
            total = s.execute(
                "SELECT COALESCE(SUM(token_total), 0), COALESCE(SUM(cost_total), 0) "
                "FROM usage_rollup WHERE (%s::timestamptz IS NULL OR window_start >= %s) "
                "AND (%s::timestamptz IS NULL OR window_end <= %s)",
                (ws, ws, we, we),
            ).fetchone()

            top = s.execute(
                "SELECT employee_id, SUM(token_total) AS tokens "
                "FROM usage_rollup WHERE employee_id IS NOT NULL "
                "AND (%s::timestamptz IS NULL OR window_start >= %s) "
                "AND (%s::timestamptz IS NULL OR window_end <= %s) "
                "GROUP BY employee_id ORDER BY tokens DESC LIMIT 1",
                (ws, ws, we, we),
            ).fetchone()

            trend_rows = s.execute(
                "SELECT date_trunc('day', window_start)::date AS day, "
                "SUM(token_total) AS tokens, SUM(cost_total) AS cost "
                "FROM usage_rollup "
                "WHERE (%s::timestamptz IS NULL OR window_start >= %s) "
                "AND (%s::timestamptz IS NULL OR window_end <= %s) "
                "GROUP BY day ORDER BY day",
                (ws, ws, we, we),
            ).fetchall()

            ranking_rows = s.execute(
                "SELECT employee_id, SUM(token_total) AS tokens, SUM(cost_total) AS cost "
                "FROM usage_rollup WHERE employee_id IS NOT NULL "
                "AND (%s::timestamptz IS NULL OR window_start >= %s) "
                "AND (%s::timestamptz IS NULL OR window_end <= %s) "
                "GROUP BY employee_id ORDER BY tokens DESC LIMIT 50",
                (ws, ws, we, we),
            ).fetchall()

        top_employee_id = str(top[0]) if top else None
        top_employee_tokens = int(top[1]) if top else 0
        return {
            "period": period,
            "total_tokens": int(total[0]),
            "total_cost": Decimal(str(total[1])),
            "top_employee_id": top_employee_id,
            "top_employee_tokens": top_employee_tokens,
            "trend": [
                {"day": str(r[0]), "tokens": int(r[1]), "cost": Decimal(str(r[2]))}
                for r in trend_rows
            ],
            "ranking": [
                {"employee_id": str(r[0]), "tokens": int(r[1]), "cost": Decimal(str(r[2]))}
                for r in ranking_rows
            ],
        }

    def list_usage_records(
        self, ctx: TenantContext, *, period: str, employee_id: str | None = None,
    ) -> list[dict]:
        """按 tenant + period 窗口列 usage 明细（员工维度用量记录），可选按 employee_id 过滤。

        数据源：usage_ledger（逐 run 计费明细，对齐 issue #292）。tenant_id 全程经 TenantContext（D22）。
        employee_name 经 employee 表脱敏 display_name 关联；未匹配时回退到 employee_id。
        """
        window_start, window_end = _period_to_window(period)
        clauses: list[str] = []
        params: list[Any] = []
        if window_start is not None:
            clauses.append("ul.occurred_at >= %s::timestamptz")
            params.append(window_start.isoformat())
        if window_end is not None:
            clauses.append("ul.occurred_at < %s::timestamptz")
            params.append(window_end.isoformat())
        if employee_id is not None:
            clauses.append("ul.employee_id = %s::uuid")
            params.append(employee_id)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT ul.id, ul.employee_id, COALESCE(e.display_name, ul.employee_id::text) "
                "AS employee_name, ul.occurred_at, ul.input_tokens, ul.output_tokens, "
                "(ul.cost_cents::numeric / 100) AS cost "
                "FROM usage_ledger ul LEFT JOIN employee e ON e.id = ul.employee_id"
                + where + " ORDER BY ul.occurred_at DESC LIMIT 500",
                tuple(params),
            ).fetchall()
        return [
            {
                "record_id": str(r[0]),
                "employee_id": str(r[1]),
                "employee_name": r[2],
                "date": r[3].isoformat() if r[3] else None,
                "input_tokens": int(r[4]),
                "output_tokens": int(r[5]),
                "cost": Decimal(str(r[6])),
            }
            for r in rows
        ]
