"""企业级 usage/audit rollup + 软配额治理数据访问（M8，04 §6.5/§6.5.1，D13/D24）。

铁律（与 EmployeeConfigRepository 一致，D22）：
- 所有方法以 TenantContext 为隔离边界，tenant_id 只从 ctx 读，SQL 不接受调用方手写 tenant 过滤。
- RLS 强制跨租户隔离（04 §6.1.1）；三表均为租户作用域表。

红线（D13）：
- usage_rollup / audit_summary_event 只存**脱敏聚合摘要**，不存任何会话文本/prompt/token 明文/
  工具输入输出明细；本仓库字段严格对齐 shared.contracts.summary.{UsageSummary, AuditSummaryEvent}。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict


# ---- 行模型（dataclass，中立字段；绝不含会话内容）----


@dataclass(frozen=True)
class UsageRollupRow:
    """计量聚合行（对齐 shared.contracts.summary.UsageSummary）。无会话内容字段。"""

    rollup_id: str
    tenant_id: str
    summary_id: str
    employee_id: str | None
    window_start: datetime
    window_end: datetime
    run_count: int
    token_total: int
    cost_total: Decimal | None
    error_count: int
    duration_seconds_total: int
    received_at: datetime
    pricing_version: int | None = None
    pricing_status: str = "unknown"
    currency: str = "USD"
    # Agent aggregate attribution/counters.  Legacy rows stay NULL/zero where
    # the old upload contract never carried reliable attribution or counters.
    member_id: str | None = None
    prompt_count: int = 0
    settled_count: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_tokens: int = 0
    duration_ms_total: int = 0


@dataclass(frozen=True)
class AuditSummaryRow:
    """审计事件摘要行（对齐 shared.contracts.summary.AuditSummaryEvent）。无会话内容字段。"""

    event_id: str
    tenant_id: str
    summary_id: str
    actor: str
    action: str
    resource_type: str | None
    resource_id: str | None
    occurred_at: datetime
    received_at: datetime


@dataclass(frozen=True)
class QuotaPolicyRow:
    """软配额策略行（D24：默认 soft）。dimensions 为中立策略 JSON，不含会话内容。"""

    policy_id: str
    tenant_id: str
    policy_slug: str
    display_name: str
    scope: str
    target_ref: str | None
    window_start: datetime
    window_end: datetime
    dimensions: dict
    enforcement: str
    status: str
    version: int
    created_at: datetime
    updated_at: datetime


# ---- 列名与行映射 ----

_USAGE_COLUMNS = (
    "id, tenant_id, summary_id, employee_id, window_start, window_end, run_count, "
    "token_total, cost_total, pricing_version, pricing_status, currency, error_count, duration_seconds_total, received_at, "
    "member_id, prompt_count, settled_count, input_tokens, output_tokens, cache_tokens, duration_ms_total"
)

_AUDIT_COLUMNS = (
    "id, tenant_id, summary_id, actor, action, resource_type, resource_id, "
    "occurred_at, received_at"
)

_QUOTA_COLUMNS = (
    "id, tenant_id, policy_slug, display_name, scope, target_ref, window_start, window_end, "
    "dimensions, enforcement, status, version, created_at, updated_at"
)


def _row_to_usage(row: Any) -> UsageRollupRow:
    """Map both the current 22-column row and pre-0042 test/legacy rows."""

    return UsageRollupRow(
        rollup_id=str(row[0]),
        tenant_id=str(row[1]),
        summary_id=row[2],
        employee_id=str(row[3]) if row[3] is not None else None,
        window_start=row[4],
        window_end=row[5],
        run_count=int(row[6] or 0),
        token_total=int(row[7] or 0),
        cost_total=row[8],
        pricing_version=row[9] if len(row) > 9 else None,
        pricing_status=row[10] if len(row) > 10 else "unknown",
        currency=row[11] if len(row) > 11 else "USD",
        error_count=int(row[12] or 0) if len(row) > 12 else 0,
        duration_seconds_total=int(row[13] or 0) if len(row) > 13 else 0,
        received_at=row[14] if len(row) > 14 else None,
        member_id=str(row[15]) if len(row) > 15 and row[15] is not None else None,
        prompt_count=int(row[16] or 0) if len(row) > 16 else 0,
        settled_count=int(row[17] or 0) if len(row) > 17 else 0,
        input_tokens=int(row[18] or 0) if len(row) > 18 else 0,
        output_tokens=int(row[19] or 0) if len(row) > 19 else 0,
        cache_tokens=int(row[20] or 0) if len(row) > 20 else 0,
        duration_ms_total=int(row[21] or 0) if len(row) > 21 else 0,
    )


def _row_to_audit(row: Any) -> AuditSummaryRow:
    return AuditSummaryRow(
        event_id=str(row[0]),
        tenant_id=str(row[1]),
        summary_id=row[2],
        actor=row[3],
        action=row[4],
        resource_type=row[5],
        resource_id=row[6],
        occurred_at=row[7],
        received_at=row[8],
    )


def _row_to_quota(row: Any) -> QuotaPolicyRow:
    return QuotaPolicyRow(
        policy_id=str(row[0]),
        tenant_id=str(row[1]),
        policy_slug=row[2],
        display_name=row[3],
        scope=row[4],
        target_ref=row[5],
        window_start=row[6],
        window_end=row[7],
        dimensions=row[8] or {},
        enforcement=row[9],
        status=row[10],
        version=row[11],
        created_at=row[12],
        updated_at=row[13],
    )


def _to_uuid(value: str | UUID | None) -> UUID | None:
    if value is None or value == "":
        return None
    if isinstance(value, UUID):
        return value
    return UUID(str(value))


class UsageAuditQuotaRepository:
    """usage/audit rollup 聚合 + 软配额策略 CRUD 的租户内读写。

    tenant_id 全程经 TenantContext（D22）；跨租户因 RLS 不可见（04 §6.1.1）。
    """

    def __init__(self, router: PgTenantRouter):
        self._router = router

    # ---- usage rollup：消费 F13 上报的脱敏 UsageSummary ----

    @staticmethod
    def _upsert_usage_in_session(session: Any, ctx: TenantContext, *, payload: dict) -> UsageRollupRow:
        """Upsert one aggregate in an existing tenant transaction."""

        stored_cost = (
            None if payload.get("pricing_status", "unknown") == "unknown"
            else payload.get("cost_total")
        )
        row = session.execute(
            """
            INSERT INTO usage_rollup (
                tenant_id, summary_id, employee_id, window_start, window_end,
                run_count, token_total, cost_total, pricing_version, pricing_status, currency,
                error_count, duration_seconds_total, member_id, prompt_count, settled_count,
                input_tokens, output_tokens, cache_tokens, duration_ms_total
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            ON CONFLICT (tenant_id, summary_id) DO UPDATE SET
                employee_id = CASE
                    WHEN EXCLUDED.employee_id IS NULL THEN usage_rollup.employee_id
                    ELSE EXCLUDED.employee_id
                END,
                window_start = EXCLUDED.window_start,
                window_end = EXCLUDED.window_end,
                run_count = EXCLUDED.run_count,
                token_total = EXCLUDED.token_total,
                cost_total = EXCLUDED.cost_total,
                pricing_version = EXCLUDED.pricing_version,
                pricing_status = EXCLUDED.pricing_status,
                currency = EXCLUDED.currency,
                error_count = EXCLUDED.error_count,
                duration_seconds_total = EXCLUDED.duration_seconds_total,
                member_id = CASE
                    WHEN EXCLUDED.member_id IS NULL THEN usage_rollup.member_id
                    ELSE EXCLUDED.member_id
                END,
                prompt_count = EXCLUDED.prompt_count,
                settled_count = EXCLUDED.settled_count,
                input_tokens = EXCLUDED.input_tokens,
                output_tokens = EXCLUDED.output_tokens,
                cache_tokens = EXCLUDED.cache_tokens,
                duration_ms_total = EXCLUDED.duration_ms_total,
                received_at = now()
            WHERE (
                EXCLUDED.employee_id IS NULL
                OR usage_rollup.employee_id = EXCLUDED.employee_id
            ) AND (
                EXCLUDED.member_id IS NULL
                OR usage_rollup.member_id = EXCLUDED.member_id
            )
            RETURNING """ + _USAGE_COLUMNS,
            (
                _to_uuid(ctx.tenant_id), payload["summary_id"], _to_uuid(payload.get("employee_id")),
                payload["window_start"], payload["window_end"],
                payload.get("run_count", 0), payload.get("token_total", 0), stored_cost,
                payload.get("pricing_version"), payload.get("pricing_status", "unknown"), payload.get("currency", "USD"),
                payload.get("error_count", 0), payload.get("duration_seconds_total", 0),
                _to_uuid(payload.get("member_id")), payload.get("prompt_count", payload.get("run_count", 0)),
                payload.get("settled_count", 0), payload.get("input_tokens", 0), payload.get("output_tokens", 0),
                payload.get("cache_tokens", 0), payload.get("duration_ms_total", 0),
            ),
        ).fetchone()
        if row is None:
            raise Conflict("usage summary attribution is immutable once assigned")
        return _row_to_usage(row)

    def upsert_usage(self, ctx: TenantContext, *, payload: dict) -> UsageRollupRow:
        """按 (tenant_id, summary_id) 幂等落 usage_rollup 行。

        已存在则按 ON CONFLICT 更新为最新上报值（幂等重试可覆盖）。
        payload 字段对齐 shared.contracts.summary.UsageSummary；调用方负责脱敏（Agent 端已完成）。
        """

        with self._router.session(ctx) as s:
            return self._upsert_usage_in_session(s, ctx, payload=payload)

    def upsert_usage_with_delivery(
        self,
        ctx: TenantContext,
        *,
        payload: dict,
        enterprise_id: str | None = None,
    ) -> UsageRollupRow:
        """Atomically retain an aggregate and enqueue its Operator delivery.

        The delivery row is an outbox receipt, not a second usage ledger.  Both
        writes share this TenantDataSession transaction so a crash cannot leave
        a committed aggregate without its durable delivery record.
        """

        from .usage_delivery_repository import UsageOperatorDeliveryRepository

        with self._router.session(ctx) as s:
            row = self._upsert_usage_in_session(s, ctx, payload=payload)
            # The usage upsert intentionally preserves an existing attribution
            # when a replay omits optional IDs.  Carry that effective employee
            # ID into the delivery payload as well; otherwise Operator would
            # receive a null employee on an otherwise unchanged replay.
            delivery_payload = payload
            if payload.get("employee_id") is None and row.employee_id is not None:
                delivery_payload = {**payload, "employee_id": row.employee_id}
            UsageOperatorDeliveryRepository.enqueue_in_session(
                s, ctx, summary_payload=delivery_payload, enterprise_id=enterprise_id,
            )
            return row

    def list_usage(
        self,
        ctx: TenantContext,
        *,
        member_id: str | None = None,
    ) -> list[UsageRollupRow]:
        """列本 tenant usage；可按成员自有范围过滤（RLS 仍是边界）。"""
        query = "SELECT " + _USAGE_COLUMNS + " FROM usage_rollup"
        params: tuple[Any, ...] = ()
        if member_id is not None:
            query += " WHERE member_id = %s::uuid"
            params = (_to_uuid(member_id),)
        query += " ORDER BY window_start"
        with self._router.session(ctx) as s:
            rows = s.execute(query, params).fetchall()
        return [_row_to_usage(r) for r in rows]

    def aggregate_usage(
        self,
        ctx: TenantContext,
        *,
        window_start: datetime,
        window_end: datetime,
        member_id: str | None = None,
    ) -> dict:
        """按 tenant + 窗口聚合 usage；可按成员过滤，不做跨企业汇总。"""
        where = "window_start >= %s AND window_end <= %s"
        params: list[Any] = [window_start, window_end]
        if member_id is not None:
            where += " AND member_id = %s::uuid"
            params.append(_to_uuid(member_id))
        with self._router.session(ctx) as s:
            row = s.execute(
                """
                SELECT
                    COUNT(*) AS rollup_count,
                    COALESCE(SUM(run_count), 0) AS run_count,
                    COALESCE(SUM(token_total), 0) AS token_total,
                    COALESCE(SUM(cost_total) FILTER (WHERE pricing_status = 'known'), 0) AS cost_total,
                    COALESCE(SUM(token_total) FILTER (WHERE pricing_status = 'unknown'), 0) AS unknown_pricing_tokens,
                    COALESCE(SUM(run_count) FILTER (WHERE pricing_status = 'unknown'), 0) AS unknown_pricing_runs,
                    COUNT(*) FILTER (WHERE pricing_status = 'known') AS known_pricing_rollups,
                    COUNT(*) FILTER (WHERE pricing_status = 'unknown') AS unknown_pricing_rollups,
                    COALESCE(SUM(error_count), 0) AS error_count,
                    COALESCE(SUM(duration_seconds_total), 0) AS duration_seconds_total
                FROM usage_rollup
                WHERE """ + where,
                tuple(params),
            ).fetchone()
        result = {
            "rollup_count": row[0],
            "run_count": row[1],
            "token_total": row[2],
            "cost_total": row[3],
            "unknown_pricing_tokens": row[4],
            "unknown_pricing_runs": row[5],
            # Older repository fakes/adapters return the original eight-column
            # aggregate shape; the SQL path supplies exact row counts below.
            "error_count": row[-2] if len(row) >= 10 else row[6],
            "duration_seconds_total": row[-1] if len(row) >= 10 else row[7],
        }
        if len(row) >= 10:
            result.update(
                known_pricing_rollups=row[6],
                unknown_pricing_rollups=row[7],
            )
        return result

    def aggregate_usage_statistics(
        self,
        ctx: TenantContext,
        *,
        employee_id: str | None = None,
        member_id: str | None = None,
        window_start: datetime | None = None,
        window_end: datetime | None = None,
    ) -> dict[str, Any]:
        """Aggregate retained hourly summaries by optional employee/member scope.

        ``execution_count`` uses stored ``prompt_count`` and falls back to the
        legacy ``run_count`` only when that counter is zero/missing.  Delivery
        state is intentionally not part of this read, so
        pending/sending/sent/failed receipts cannot make an aggregate disappear.
        """

        clauses = ["1 = 1"]
        params: list[Any] = []
        if window_start is not None:
            clauses.append("u.window_start >= %s")
            params.append(window_start)
        if window_end is not None:
            clauses.append("u.window_end <= %s")
            params.append(window_end)
        if employee_id is not None:
            clauses.append("u.employee_id = %s::uuid")
            params.append(_to_uuid(employee_id))
        if member_id is not None:
            clauses.append("u.member_id = %s::uuid")
            params.append(_to_uuid(member_id))
        where = " AND ".join(clauses)
        with self._router.session(ctx) as s:
            row = s.execute(
                """
                SELECT
                    COUNT(*) AS summary_count,
                    COALESCE(SUM(CASE WHEN u.prompt_count > 0 THEN u.prompt_count ELSE u.run_count END), 0) AS execution_count,
                    COALESCE(SUM(u.run_count), 0) AS run_count,
                    COALESCE(SUM(u.prompt_count), 0) AS prompt_count,
                    COALESCE(SUM(u.settled_count), 0) AS settled_count,
                    COALESCE(SUM(u.error_count), 0) AS error_count,
                    COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
                    COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
                    COALESCE(SUM(u.cache_tokens), 0) AS cache_tokens,
                    COALESCE(SUM(u.token_total), 0) AS token_total,
                    COALESCE(SUM(u.duration_ms_total), 0) AS duration_ms_total,
                    COALESCE(SUM(u.duration_seconds_total), 0) AS duration_seconds_total,
                    COALESCE(SUM(u.cost_total) FILTER (WHERE u.pricing_status = 'known'), 0) AS known_cost_total,
                    COALESCE(SUM(u.token_total) FILTER (WHERE u.pricing_status = 'unknown'), 0) AS unknown_pricing_tokens,
                    COALESCE(SUM(CASE WHEN u.prompt_count > 0 THEN u.prompt_count ELSE u.run_count END) FILTER (WHERE u.pricing_status = 'unknown'), 0) AS unknown_pricing_runs,
                    COUNT(*) FILTER (WHERE u.pricing_status = 'unknown') AS unknown_summary_count
                FROM usage_rollup AS u
                WHERE """ + where,
                tuple(params),
            ).fetchone()
        return {
            "summary_count": int(row[0] or 0),
            "execution_count": int(row[1] or 0),
            "run_count": int(row[2] or 0),
            "prompt_count": int(row[3] or 0),
            "settled_count": int(row[4] or 0),
            "error_count": int(row[5] or 0),
            "input_tokens": int(row[6] or 0),
            "output_tokens": int(row[7] or 0),
            "cache_tokens": int(row[8] or 0),
            "token_total": int(row[9] or 0),
            "duration_ms_total": int(row[10] or 0),
            "duration_seconds_total": int(row[11] or 0),
            "known_cost_total": row[12],
            "unknown_pricing_tokens": int(row[13] or 0),
            "unknown_pricing_runs": int(row[14] or 0),
            "unknown_summary_count": int(row[15] or 0),
        }

    def list_usage_history(
        self,
        ctx: TenantContext,
        *,
        employee_id: str | None = None,
        member_id: str | None = None,
        window_start: datetime | None = None,
        window_end: datetime | None = None,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        """List Manager-held aggregate/work metadata, never session content."""

        clauses = ["1 = 1"]
        params: list[Any] = []
        if window_start is not None:
            clauses.append("u.window_start >= %s")
            params.append(window_start)
        if window_end is not None:
            clauses.append("u.window_end <= %s")
            params.append(window_end)
        if employee_id is not None:
            clauses.append("u.employee_id = %s::uuid")
            params.append(_to_uuid(employee_id))
        if member_id is not None:
            clauses.append("u.member_id = %s::uuid")
            params.append(_to_uuid(member_id))
        safe_limit = max(1, min(int(limit), 500))
        with self._router.session(ctx) as s:
            rows = s.execute(
                """
                SELECT u.id, u.summary_id, u.member_id, u.employee_id,
                       e.display_name, m.display_name,
                       u.window_start, u.window_end, u.run_count,
                       u.prompt_count, u.settled_count, u.token_total,
                       u.cost_total, u.pricing_version, u.pricing_status, u.currency,
                       u.error_count, u.duration_seconds_total, u.duration_ms_total,
                       u.received_at
                FROM usage_rollup AS u
                LEFT JOIN employee AS e ON e.id = u.employee_id
                LEFT JOIN app_user AS m ON m.id = u.member_id
                WHERE """ + " AND ".join(clauses) + "\n                ORDER BY u.window_start DESC, u.received_at DESC, u.id DESC LIMIT %s",
                tuple(params + [safe_limit]),
            ).fetchall()
        return [
            {
                "rollup_id": str(row[0]),
                "summary_id": str(row[1]),
                "member_id": str(row[2]) if row[2] is not None else None,
                "employee_id": str(row[3]) if row[3] is not None else None,
                # A missing legacy identity remains unknown.  A known but
                # deleted identity is explicitly labelled as deleted, not
                # reassigned to the current request principal.
                "member_display_name": row[5] if row[5] else ("未知成员" if row[2] is None else "已删除成员"),
                "employee_display_name": row[4] if row[4] else ("未知员工" if row[3] is None else "已删除员工"),
                "window_start": row[6],
                "window_end": row[7],
                "run_count": int(row[8] or 0),
                "prompt_count": int(row[9] or 0),
                "settled_count": int(row[10] or 0),
                "token_total": int(row[11] or 0),
                "cost_total": row[12],
                "pricing_version": row[13],
                "pricing_status": row[14] or "unknown",
                "currency": row[15] or "USD",
                "error_count": int(row[16] or 0),
                "duration_seconds_total": int(row[17] or 0),
                "duration_ms_total": int(row[18] or 0),
                "received_at": row[19],
            }
            for row in rows
        ]

    def employee_exists(self, ctx: TenantContext, *, employee_id: str) -> bool:
        """Return whether an employee is visible in the authenticated tenant."""

        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT id FROM employee WHERE id = %s::uuid",
                (_to_uuid(employee_id),),
            ).fetchone()
        return row is not None

    def employee_granted_to_member(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        member_id: str,
    ) -> bool:
        """Check the member_grant audience for one tenant employee.

        The employee/member/grant relations are all RLS-scoped.  No caller
        supplied tenant predicate is accepted here.
        """

        with self._router.session(ctx) as s:
            row = s.execute(
                """
                SELECT EXISTS (
                    SELECT 1
                    FROM employee AS e
                    JOIN member_grant AS g
                      ON g.resource_type = 'expert' AND g.resource_id = e.id
                    WHERE e.id = %s::uuid
                      AND (
                          %s::uuid = ANY(g.member_ids)
                          OR EXISTS (
                              SELECT 1
                              FROM app_user AS m
                              WHERE m.id = %s::uuid
                                AND g.department_ids && m.department_ids
                          )
                      )
                )
                """,
                (_to_uuid(employee_id), _to_uuid(member_id), _to_uuid(member_id)),
            ).fetchone()
        return bool(row and row[0])

    # ---- audit summary：消费 F13 上报的脱敏 AuditSummaryEvent ----

    def upsert_audit(self, ctx: TenantContext, *, payload: dict) -> AuditSummaryRow:
        """按 (tenant_id, summary_id) 幂等落 audit_summary_event 行。无会话内容。"""
        tenant_uuid = _to_uuid(ctx.tenant_id)
        with self._router.session(ctx) as s:
            row = s.execute(
                """
                INSERT INTO audit_summary_event (
                    tenant_id, summary_id, actor, action, resource_type, resource_id, occurred_at
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s
                )
                ON CONFLICT (tenant_id, summary_id) DO UPDATE SET
                    actor = EXCLUDED.actor,
                    action = EXCLUDED.action,
                    resource_type = EXCLUDED.resource_type,
                    resource_id = EXCLUDED.resource_id,
                    occurred_at = EXCLUDED.occurred_at,
                    received_at = now()
                RETURNING """ + _AUDIT_COLUMNS,
                (
                    tenant_uuid, payload["summary_id"], payload["actor"], payload["action"],
                    payload.get("resource_type"), payload.get("resource_id"),
                    payload["occurred_at"],
                ),
            ).fetchone()
        return _row_to_audit(row)

    def list_audits(
        self,
        ctx: TenantContext,
        *,
        actor: str | None = None,
    ) -> list[AuditSummaryRow]:
        query = "SELECT " + _AUDIT_COLUMNS + " FROM audit_summary_event"
        params: tuple[Any, ...] = ()
        if actor is not None:
            query += " WHERE actor = %s"
            params = (actor,)
        query += " ORDER BY occurred_at"
        with self._router.session(ctx) as s:
            rows = s.execute(query, params).fetchall()
        return [_row_to_audit(r) for r in rows]

    # ---- quota_policy：软配额策略 CRUD（D24 默认 soft）----

    def create_quota(
        self, ctx: TenantContext, *, policy_slug: str, display_name: str,
        scope: str, target_ref: str | None, window_start: datetime, window_end: datetime,
        dimensions: dict, enforcement: str, status: str,
    ) -> QuotaPolicyRow:
        """在本 tenant 建配额策略行。tenant_id 取自 ctx（D22，RLS WITH CHECK 兜底）。"""
        tenant_uuid = _to_uuid(ctx.tenant_id)
        with self._router.session(ctx) as s:
            row = s.execute(
                """
                INSERT INTO quota_policy (
                    tenant_id, policy_slug, display_name, scope, target_ref,
                    window_start, window_end, dimensions, enforcement, status
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                RETURNING """ + _QUOTA_COLUMNS,
                (
                    tenant_uuid, policy_slug, display_name, scope, target_ref,
                    window_start, window_end, json.dumps(dimensions), enforcement, status,
                ),
            ).fetchone()
        return _row_to_quota(row)

    def get_quota(self, ctx: TenantContext, *, policy_id: str) -> QuotaPolicyRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _QUOTA_COLUMNS + " FROM quota_policy WHERE id = %s",
                (_to_uuid(policy_id),),
            ).fetchone()
        return _row_to_quota(row) if row is not None else None

    def get_quota_by_slug(self, ctx: TenantContext, *, policy_slug: str) -> QuotaPolicyRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _QUOTA_COLUMNS + " FROM quota_policy WHERE policy_slug = %s",
                (policy_slug,),
            ).fetchone()
        return _row_to_quota(row) if row is not None else None

    def update_quota(
        self, ctx: TenantContext, *, policy_id: str, display_name: str,
        scope: str, target_ref: str | None, window_start: datetime, window_end: datetime,
        dimensions: dict, enforcement: str, status: str,
    ) -> QuotaPolicyRow | None:
        """改写本 tenant 内配额策略（version 由触发器自增）。跨 tenant 行 RLS 不可见。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                """
                UPDATE quota_policy SET
                    display_name = %s, scope = %s, target_ref = %s,
                    window_start = %s, window_end = %s, dimensions = %s,
                    enforcement = %s, status = %s
                WHERE id = %s
                RETURNING """ + _QUOTA_COLUMNS,
                (
                    display_name, scope, target_ref, window_start, window_end,
                    json.dumps(dimensions), enforcement, status, _to_uuid(policy_id),
                ),
            ).fetchone()
        return _row_to_quota(row) if row is not None else None

    def delete_quota(self, ctx: TenantContext, *, policy_id: str) -> bool:
        with self._router.session(ctx) as s:
            row = s.execute(
                "DELETE FROM quota_policy WHERE id = %s RETURNING id", (_to_uuid(policy_id),)
            ).fetchone()
        return row is not None

    def list_quotas(self, ctx: TenantContext) -> list[QuotaPolicyRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _QUOTA_COLUMNS + " FROM quota_policy ORDER BY created_at"
            ).fetchall()
        return [_row_to_quota(r) for r in rows]
