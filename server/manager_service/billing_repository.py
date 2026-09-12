"""Billing 账户余额与充值记录的租户作用域数据访问。

新表 billing_balance / recharge_record（migration 0010）。tenant_id 只从 TenantContext 读（D22）。
本模块同时承载 usage overview / records 的聚合查询（复用 usage_rollup 脱敏聚合数据）。
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

    None 端表示无边界（all 时两端都为 None）。时区对齐 UTC，与 usage_rollup 一致。
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
            if row is None:
                raise RuntimeError("recharge insert returned no row")
            # A settled recharge credits the ledger and visible aggregate in
            # the same tenant transaction. Pending payment intents deliberately
            # do not credit balance until a later, equally atomic settlement.
            if status == "success":
                s.execute(
                    "INSERT INTO billing_balance (tenant_id, balance, estimated_tokens) "
                    "VALUES (%s, %s, %s) "
                    "ON CONFLICT (tenant_id) DO UPDATE SET "
                    "balance = billing_balance.balance + EXCLUDED.balance, "
                    "estimated_tokens = billing_balance.estimated_tokens + EXCLUDED.estimated_tokens, "
                    "updated_at = now()",
                    (ctx.tenant_id, str(amount), token_credited),
                )
        return _row_to_recharge(row)

    def list_recharges(self, ctx: TenantContext) -> list[RechargeRecordRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT id, amount, payment_method, status, order_no, token_credited, created_at "
                "FROM recharge_record ORDER BY created_at DESC LIMIT 200",
            ).fetchall()
        return [_row_to_recharge(r) for r in rows]

    # ---- usage overview / records：复用 usage_rollup 的脱敏聚合数据 ----

    def get_usage_overview(
        self,
        ctx: TenantContext,
        *,
        period: str,
        employee_id: str | None = None,
        member_id: str | None = None,
    ) -> dict:
        """按 tenant + period 窗口聚合 usage overview（总消耗 Token / 折合费用 / 消耗最高员工 + 趋势 + 排名）。

        数据源：usage_rollup（脱敏聚合摘要，对齐 shared.contracts.summary.UsageSummary）。
        tenant_id 全程经 TenantContext（D22）；跨租户因 RLS 不可见。
        """
        window_start, window_end = _period_to_window(period)
        ws = window_start
        we = window_end
        scope_clauses: list[str] = []
        scope_params: list[Any] = []
        if employee_id is not None:
            scope_clauses.append("employee_id = %s::uuid")
            scope_params.append(employee_id)
        if member_id is not None:
            scope_clauses.append("member_id = %s::uuid")
            scope_params.append(member_id)
        scope_sql = (" AND " + " AND ".join(scope_clauses)) if scope_clauses else ""
        with self._router.session(ctx) as s:
            total = s.execute(
                "SELECT COALESCE(SUM(token_total), 0), "
                "COALESCE(SUM(cost_total) FILTER (WHERE pricing_status = 'known'), 0), "
                "COALESCE(SUM(token_total) FILTER (WHERE pricing_status = 'unknown'), 0), "
                "COALESCE(SUM(run_count) FILTER (WHERE pricing_status = 'unknown'), 0), "
                "COALESCE(SUM(cost_total) FILTER (WHERE pricing_status = 'known'), 0), "
                "COUNT(*) FILTER (WHERE pricing_status = 'unknown'), COUNT(*), "
                "COALESCE(SUM(CASE WHEN prompt_count > 0 THEN prompt_count ELSE run_count END), 0), "
                "COALESCE(SUM(run_count), 0) "
                "FROM usage_rollup WHERE (%s::timestamptz IS NULL OR window_start >= %s) "
                "AND (%s::timestamptz IS NULL OR window_end <= %s)" + scope_sql,
                (ws, ws, we, we, *scope_params),
            ).fetchone()

            top = s.execute(
                "SELECT employee_id, SUM(token_total) AS tokens "
                "FROM usage_rollup WHERE employee_id IS NOT NULL "
                "AND (%s::timestamptz IS NULL OR window_start >= %s) "
                "AND (%s::timestamptz IS NULL OR window_end <= %s)" + scope_sql +
                " GROUP BY employee_id ORDER BY tokens DESC LIMIT 1",
                (ws, ws, we, we, *scope_params),
            ).fetchone()

            trend_rows = s.execute(
                "SELECT (date_trunc('day', window_start AT TIME ZONE 'UTC'))::date AS day, "
                "SUM(token_total) AS tokens, "
                "SUM(cost_total) FILTER (WHERE pricing_status = 'known') AS cost, "
                "COUNT(*) FILTER (WHERE pricing_status = 'unknown') AS unknown_count "
                "FROM usage_rollup "
                "WHERE (%s::timestamptz IS NULL OR window_start >= %s) "
                "AND (%s::timestamptz IS NULL OR window_end <= %s)" + scope_sql +
                " GROUP BY day ORDER BY day",
                (ws, ws, we, we, *scope_params),
            ).fetchall()

            ranking_rows = s.execute(
                "SELECT employee_id, SUM(token_total) AS tokens, "
                "SUM(cost_total) FILTER (WHERE pricing_status = 'known') AS cost, "
                "COUNT(*) FILTER (WHERE pricing_status = 'unknown') AS unknown_count "
                "FROM usage_rollup WHERE employee_id IS NOT NULL "
                "AND (%s::timestamptz IS NULL OR window_start >= %s) "
                "AND (%s::timestamptz IS NULL OR window_end <= %s)" + scope_sql +
                " GROUP BY employee_id ORDER BY tokens DESC LIMIT 50",
                (ws, ws, we, we, *scope_params),
            ).fetchall()

        top_employee_id = str(top[0]) if top else None
        top_employee_tokens = int(top[1]) if top else 0
        # Four-column rows are old test/adapter results and retain the legacy
        # numeric field shape.  Real post-0042 rows expose known-only and
        # nullable total-spending semantics through the additional columns.
        if len(total) > 4:
            raw_known_cost = Decimal(str(total[4] or 0))
            unknown_summaries = int(total[5] or 0)
            summary_count = int(total[6] or 0)
            execution_count = int(total[7] or 0) if len(total) > 7 else 0
            raw_run_count = int(total[8] or 0) if len(total) > 8 else 0
            pricing_status = (
                "unknown" if summary_count == 0 or unknown_summaries >= summary_count
                else "partial" if unknown_summaries else "known"
            )
            known_cost = None if summary_count == 0 or unknown_summaries >= summary_count else raw_known_cost
            total_cost = None if unknown_summaries or not summary_count else known_cost
        else:
            known_cost = Decimal(str(total[1] or 0))
            unknown_summaries = int(total[2] or 0) > 0 or int(total[3] or 0) > 0
            summary_count = 0
            pricing_status = "unknown" if unknown_summaries else "known"
            total_cost = Decimal(str(total[1] or 0))
        result = {
            "period": period,
            "total_tokens": int(total[0]),
            "total_cost": total_cost,
            "unknown_pricing_tokens": int(total[2]),
            "unknown_pricing_runs": int(total[3]),
            "top_employee_id": top_employee_id,
            "top_employee_tokens": top_employee_tokens,
            "trend": [
                {
                    "day": str(r[0]),
                    "tokens": int(r[1]),
                    "cost": (
                        None
                        if (len(r) > 3 and r[3]) or r[2] is None
                        else Decimal(str(r[2]))
                    ),
                }
                for r in trend_rows
            ],
            "ranking": [
                {
                    "employee_id": str(r[0]),
                    "tokens": int(r[1]),
                    "cost": (
                        None
                        if (len(r) > 3 and r[3]) or r[2] is None
                        else Decimal(str(r[2]))
                    ),
                }
                for r in ranking_rows
            ],
        }
        if len(total) > 4:
            result.update({
                "known_cost_total": known_cost,
                "total_spending": None if unknown_summaries else known_cost,
                "pricing_status": pricing_status,
                "summary_count": summary_count,
                "execution_count": execution_count,
                "run_count": raw_run_count,
            })
        return result

    def list_usage_records(
        self,
        ctx: TenantContext,
        *,
        period: str,
        employee_id: str | None = None,
        member_id: str | None = None,
    ) -> list[dict]:
        """列脱敏 usage_rollup 摘要；不读取 runtime/run 明细。

        Rows without legacy employee/member attribution are retained with null
        ids and explicit unknown labels rather than being silently omitted.
        """
        window_start, window_end = _period_to_window(period)
        # Keep this explicit identity predicate for legacy SQL observability,
        # while the OR branch deliberately retains unknown employee rows.
        clauses: list[str] = ["(u.employee_id IS NOT NULL OR u.employee_id IS NULL)"]
        params: list[Any] = []
        if window_start is not None:
            clauses.append("u.window_start >= %s")
            params.append(window_start)
        if window_end is not None:
            clauses.append("u.window_end <= %s")
            params.append(window_end)
        if employee_id is not None:
            clauses.append("u.employee_id = %s::uuid")
            params.append(employee_id)
        if member_id is not None:
            clauses.append("u.member_id = %s::uuid")
            params.append(member_id)
        where = " WHERE " + " AND ".join(clauses)
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT u.id, u.employee_id, u.member_id, "
                "COALESCE(NULLIF(e.display_name, ''), NULLIF(e.employee_slug, '')) AS employee_name, "
                "COALESCE(NULLIF(m.display_name, ''), NULL) AS member_name, "
                "u.window_start, u.window_end, u.token_total, u.cost_total, u.run_count, "
                "u.pricing_status, u.prompt_count "
                "FROM usage_rollup AS u "
                "LEFT JOIN employee AS e ON e.id = u.employee_id "
                "LEFT JOIN app_user AS m ON m.id = u.member_id" + where +
                " ORDER BY u.window_start DESC, u.received_at DESC, u.id DESC LIMIT 500",
                tuple(params),
            ).fetchall()
        output: list[dict] = []
        for row in rows:
            # Keep the old six-column fake/repository response compatible while
            # using the richer attribution shape on real Manager PostgreSQL.
            if len(row) < 11:
                employee_id_value = str(row[1]) if row[1] is not None else None
                employee_name = str(row[2]) if row[2] else ("未知员工" if row[1] is None else "已删除员工")
                window_start_value, window_end_value = row[3], None
                token_total, cost_value = int(row[4] or 0), Decimal(str(row[5] or 0))
                member_id_value, member_name, run_count, pricing_status, prompt_count = None, None, 0, "known", 0
            else:
                employee_id_value = str(row[1]) if row[1] is not None else None
                member_id_value = str(row[2]) if row[2] is not None else None
                employee_name = row[3] or ("未知员工" if employee_id_value is None else "已删除员工")
                member_name = row[4] or ("未知成员" if member_id_value is None else "已删除成员")
                window_start_value, window_end_value = row[5], row[6]
                token_total = int(row[7] or 0)
                raw_cost = row[8]
                cost_value = None if raw_cost is None else Decimal(str(raw_cost))
                run_count, pricing_status = int(row[9] or 0), row[10] or "unknown"
                if pricing_status == "known" and cost_value is None:
                    pricing_status = "unknown"
                prompt_count = int(row[11] or 0) if len(row) > 11 else 0
            cost = cost_value if pricing_status == "known" else None
            execution_count = prompt_count or run_count
            output.append({
                "record_id": str(row[0]),
                "employee_id": employee_id_value,
                "employee_name": str(employee_name),
                "member_id": member_id_value,
                "member_name": member_name,
                "date": window_start_value.isoformat() if window_start_value else None,
                "window_start": window_start_value,
                "window_end": window_end_value,
                "token_total": token_total,
                "total_tokens": token_total,
                "token_spending": token_total,
                "cost": cost,
                "total_cost": cost,
                "total_spending": cost,
                "run_count": run_count,
                "execution_count": execution_count,
                "task_count": None,
                "task_count_status": "unknown",
                "pricing_status": pricing_status,
            })
        return output
