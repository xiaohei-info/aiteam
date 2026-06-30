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
    cost_total: Decimal
    error_count: int
    duration_seconds_total: int
    received_at: datetime


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
    "token_total, cost_total, error_count, duration_seconds_total, received_at"
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
    return UsageRollupRow(
        rollup_id=str(row[0]),
        tenant_id=str(row[1]),
        summary_id=row[2],
        employee_id=str(row[3]) if row[3] is not None else None,
        window_start=row[4],
        window_end=row[5],
        run_count=row[6],
        token_total=row[7],
        cost_total=row[8],
        error_count=row[9],
        duration_seconds_total=row[10],
        received_at=row[11],
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
    if value is None:
        return None
    if isinstance(value, UUID):
        return value
    return UUID(value)


class UsageAuditQuotaRepository:
    """usage/audit rollup 聚合 + 软配额策略 CRUD 的租户内读写。

    tenant_id 全程经 TenantContext（D22）；跨租户因 RLS 不可见（04 §6.1.1）。
    """

    def __init__(self, router: PgTenantRouter):
        self._router = router

    # ---- usage rollup：消费 F13 上报的脱敏 UsageSummary ----

    def upsert_usage(self, ctx: TenantContext, *, payload: dict) -> UsageRollupRow:
        """按 (tenant_id, summary_id) 幂等落 usage_rollup 行。

        已存在则按 ON CONFLICT 更新为最新上报值（幂等重试可覆盖）。
        payload 字段对齐 shared.contracts.summary.UsageSummary；调用方负责脱敏（Agent 端已完成）。
        """
        tenant_uuid = _to_uuid(ctx.tenant_id)
        emp_uuid = _to_uuid(payload.get("employee_id"))
        with self._router.session(ctx) as s:
            row = s.execute(
                """
                INSERT INTO usage_rollup (
                    tenant_id, summary_id, employee_id, window_start, window_end,
                    run_count, token_total, cost_total, error_count, duration_seconds_total
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                ON CONFLICT (tenant_id, summary_id) DO UPDATE SET
                    employee_id = EXCLUDED.employee_id,
                    window_start = EXCLUDED.window_start,
                    window_end = EXCLUDED.window_end,
                    run_count = EXCLUDED.run_count,
                    token_total = EXCLUDED.token_total,
                    cost_total = EXCLUDED.cost_total,
                    error_count = EXCLUDED.error_count,
                    duration_seconds_total = EXCLUDED.duration_seconds_total,
                    received_at = now()
                RETURNING """ + _USAGE_COLUMNS,
                (
                    tenant_uuid, payload["summary_id"], emp_uuid,
                    payload["window_start"], payload["window_end"],
                    payload["run_count"], payload["token_total"], payload["cost_total"],
                    payload["error_count"], payload["duration_seconds_total"],
                ),
            ).fetchone()
        return _row_to_usage(row)

    def list_usage(self, ctx: TenantContext) -> list[UsageRollupRow]:
        """列本 tenant 内全部 usage_rollup（RLS 自动限定）。"""
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _USAGE_COLUMNS + " FROM usage_rollup ORDER BY window_start"
            ).fetchall()
        return [_row_to_usage(r) for r in rows]

    def aggregate_usage(
        self, ctx: TenantContext, *, window_start: datetime, window_end: datetime,
    ) -> dict:
        """按 tenant + 窗口聚合 usage（run/token/cost/error/duration 汇总）。不做跨企业汇总（归 O3）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                """
                SELECT
                    COUNT(*) AS rollup_count,
                    COALESCE(SUM(run_count), 0) AS run_count,
                    COALESCE(SUM(token_total), 0) AS token_total,
                    COALESCE(SUM(cost_total), 0) AS cost_total,
                    COALESCE(SUM(error_count), 0) AS error_count,
                    COALESCE(SUM(duration_seconds_total), 0) AS duration_seconds_total
                FROM usage_rollup
                WHERE window_start >= %s AND window_end <= %s
                """,
                (window_start, window_end),
            ).fetchone()
        return {
            "rollup_count": row[0],
            "run_count": row[1],
            "token_total": row[2],
            "cost_total": row[3],
            "error_count": row[4],
            "duration_seconds_total": row[5],
        }

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

    def list_audits(self, ctx: TenantContext) -> list[AuditSummaryRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _AUDIT_COLUMNS + " FROM audit_summary_event ORDER BY occurred_at"
            ).fetchall()
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

    # ---- run_event：runtime 归一事件脱敏归档（issue #292）----

    def append_run_event(self, ctx: TenantContext, *, run_id: str, cursor_no: int,
                         event_type: str, source_type: str, source_id: str,
                         team_task_id: str | None = None, employee_id: str | None = None,
                         event_ts: str | None = None, preview_text: str = "",
                         payload_json: dict | None = None) -> RunEventRow | None:
        """归档单条 run-event；ON CONFLICT DO NOTHING 去重（重复归档静默跳过，返回 None）。

        event_ts/preview_text 为空时让 PG 走 DEFAULT，对齐旧 run_event_repo 行为。
        调用方对 preview_text/payload_json 的脱敏负责（D13）。
        """
        tenant_uuid = _to_uuid(ctx.tenant_id)
        rid = _to_uuid(run_id)
        tt = _to_uuid(team_task_id)
        eid = _to_uuid(employee_id)
        import json
        cols = ["tenant_id", "run_id", "cursor_no", "event_type", "source_type", "source_id",
                "team_task_id", "employee_id"]
        vals: list[object] = [tenant_uuid, rid, cursor_no, event_type, source_type, source_id, tt, eid]
        if event_ts:
            cols.append("event_ts")
            vals.append(event_ts)
        if preview_text:
            cols.append("preview_text")
            vals.append(preview_text)
        cols.append("payload_json")
        vals.append(json.dumps(payload_json or {}))
        col_spec = ", ".join(cols)
        ph = ", ".join(["%s"] * len(vals))
        with self._router.session(ctx) as s:
            row = s.execute(
                f"INSERT INTO run_event ({col_spec}) VALUES ({ph}) "
                "ON CONFLICT (tenant_id, run_id, cursor_no) DO NOTHING "
                "RETURNING " + _RUN_COLUMNS,
                vals,
            ).fetchone()
        return _row_to_run(row) if row is not None else None

    def list_run_events(self, ctx: TenantContext, *, run_id: str, after_cursor: int = 0,
                        limit: int = 100) -> list[RunEventRow]:
        """cursor 分页列 run 的事件（cursor_no > after_cursor，ASC）。"""
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _RUN_COLUMNS + " FROM run_event "
                "WHERE run_id = %s AND cursor_no > %s "
                "ORDER BY cursor_no ASC LIMIT %s",
                (_to_uuid(run_id), after_cursor, limit),
            ).fetchall()
        return [_row_to_run(r) for r in rows]

    def get_max_cursor(self, ctx: TenantContext, *, run_id: str) -> int:
        """某 run 当前最大游标水位；无事件返回 0。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT COALESCE(MAX(cursor_no), 0) FROM run_event WHERE run_id = %s",
                (_to_uuid(run_id),),
            ).fetchone()
        return row[0] if row else 0

    def get_latest_run_event(self, ctx: TenantContext, *, run_id: str) -> RunEventRow | None:
        """某 run 最新一条事件（按 cursor_no DESC）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _RUN_COLUMNS + " FROM run_event WHERE run_id = %s "
                "ORDER BY cursor_no DESC LIMIT 1",
                (_to_uuid(run_id),),
            ).fetchone()
        return _row_to_run(row) if row is not None else None

    # ---- usage_ledger：逐 token 计费明细（issue #292）----

    def create_ledger(self, ctx: TenantContext, *, payload: dict) -> UsageLedgerRow:
        """写入一行 usage_ledger（insert）。tenant_id 取自 ctx（D22）。"""
        tenant_uuid = _to_uuid(ctx.tenant_id)
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO usage_ledger (tenant_id, run_id, employee_id, conversation_id, "
                "input_tokens, output_tokens, total_tokens, cost_cents, source_type, occurred_at, created_by) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, "
                "COALESCE(NULLIF(%s, '')::timestamptz, now()), %s) "
                "RETURNING " + _LEDGER_COLUMNS,
                (
                    tenant_uuid, _to_uuid(payload["run_id"]), _to_uuid(payload["employee_id"]),
                    _to_uuid(payload.get("conversation_id")), payload.get("input_tokens", 0),
                    payload.get("output_tokens", 0), payload.get("total_tokens", 0),
                    payload.get("cost_cents", 0), payload.get("source_type", "run_summary"),
                    payload.get("occurred_at"), payload.get("created_by"),
                ),
            ).fetchone()
        return _row_to_ledger(row)

    def upsert_ledger(self, ctx: TenantContext, *, payload: dict) -> UsageLedgerRow:
        """按 (tenant_id, run_id, source_type) 幂等回写 usage_ledger（F13 重复上报覆盖）。"""
        tenant_uuid = _to_uuid(ctx.tenant_id)
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO usage_ledger (tenant_id, run_id, employee_id, conversation_id, "
                "input_tokens, output_tokens, total_tokens, cost_cents, source_type, occurred_at, created_by) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, "
                "COALESCE(NULLIF(%s, '')::timestamptz, now()), %s) "
                "ON CONFLICT (tenant_id, run_id, source_type) DO UPDATE SET "
                "employee_id=EXCLUDED.employee_id, conversation_id=EXCLUDED.conversation_id, "
                "input_tokens=EXCLUDED.input_tokens, output_tokens=EXCLUDED.output_tokens, "
                "total_tokens=EXCLUDED.total_tokens, cost_cents=EXCLUDED.cost_cents, "
                "occurred_at=EXCLUDED.occurred_at, created_by=EXCLUDED.created_by, created_at=now() "
                "RETURNING " + _LEDGER_COLUMNS,
                (
                    tenant_uuid, _to_uuid(payload["run_id"]), _to_uuid(payload["employee_id"]),
                    _to_uuid(payload.get("conversation_id")), payload.get("input_tokens", 0),
                    payload.get("output_tokens", 0), payload.get("total_tokens", 0),
                    payload.get("cost_cents", 0), payload.get("source_type", "run_summary"),
                    payload.get("occurred_at"), payload.get("created_by"),
                ),
            ).fetchone()
        return _row_to_ledger(row)

    def get_ledger_by_run(self, ctx: TenantContext, *, run_id: str, source_type: str) -> UsageLedgerRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _LEDGER_COLUMNS + " FROM usage_ledger "
                "WHERE run_id = %s AND source_type = %s",
                (_to_uuid(run_id), source_type),
            ).fetchone()
        return _row_to_ledger(row) if row is not None else None

    def list_ledger(self, ctx: TenantContext, *, run_id: str | None = None,
                    employee_id: str | None = None,
                    period_start: str | None = None, period_end: str | None = None) -> list[UsageLedgerRow]:
        clauses: list[str] = []
        params: list[object] = []
        if run_id is not None:
            clauses.append("run_id = %s")
            params.append(_to_uuid(run_id))
        if employee_id is not None:
            clauses.append("employee_id = %s")
            params.append(_to_uuid(employee_id))
        if period_start:
            clauses.append("occurred_at >= %s::timestamptz")
            params.append(period_start)
        if period_end:
            clauses.append("occurred_at < %s::timestamptz")
            params.append(period_end)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _LEDGER_COLUMNS + f" FROM usage_ledger{where} "
                "ORDER BY occurred_at DESC, id DESC",
                tuple(params),
            ).fetchall()
        return [_row_to_ledger(r) for r in rows]


# ---- run_event（运行事件明细）+ usage_ledger（逐 token 计费明细）----
#
# 补齐 Manager usage/audit 模块缺失的完整事件追踪（issue #292 / GitHub #292）。租户隔离一致：所有
# 行模型 tenant_id 取自 TenantContext（D22），跨租户因 RLS 不可见（04 §6.1.1）。
#
# 红线（D13）：run_event 仅承载脱敏事件元数据；usage_ledger 仅承载逐 run 计量数字。两表均不含任何
# 会话文本/prompt/session 内容/工具 IO 明文字段。


@dataclass(frozen=True)
class RunEventRow:
    """运行事件明细行（对齐旧 entities.RunEvent + run_event_repo）。无会话内容字段。"""

    event_id: str
    tenant_id: str
    run_id: str
    cursor_no: int
    event_type: str
    source_type: str
    source_id: str
    team_task_id: str | None
    employee_id: str | None
    event_ts: datetime
    preview_text: str
    payload_json: dict
    created_at: datetime


@dataclass(frozen=True)
class UsageLedgerRow:
    """逐 token 计费明细行（对齐旧 entities.UsageLedger + usage_ledger_repo）。无会话内容字段。"""

    ledger_id: str
    tenant_id: str
    run_id: str
    employee_id: str
    conversation_id: str | None
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost_cents: int
    source_type: str
    occurred_at: datetime
    created_at: datetime
    created_by: str | None


_RUN_COLUMNS = (
    "id, tenant_id, run_id, cursor_no, event_type, source_type, source_id, "
    "team_task_id, employee_id, event_ts, preview_text, payload_json, created_at"
)

_LEDGER_COLUMNS = (
    "id, tenant_id, run_id, employee_id, conversation_id, input_tokens, output_tokens, "
    "total_tokens, cost_cents, source_type, occurred_at, created_at, created_by"
)


def _row_to_run(row: Any) -> RunEventRow:
    return RunEventRow(
        event_id=str(row[0]),
        tenant_id=str(row[1]),
        run_id=str(row[2]),
        cursor_no=row[3],
        event_type=row[4],
        source_type=row[5],
        source_id=str(row[6]),
        team_task_id=str(row[7]) if row[7] is not None else None,
        employee_id=str(row[8]) if row[8] is not None else None,
        event_ts=row[9],
        preview_text=row[10] or "",
        payload_json=row[11] if isinstance(row[11], dict) else {},
        created_at=row[12],
    )


def _row_to_ledger(row: Any) -> UsageLedgerRow:
    return UsageLedgerRow(
        ledger_id=str(row[0]),
        tenant_id=str(row[1]),
        run_id=str(row[2]),
        employee_id=str(row[3]),
        conversation_id=str(row[4]) if row[4] is not None else None,
        input_tokens=row[5],
        output_tokens=row[6],
        total_tokens=row[7],
        cost_cents=row[8],
        source_type=row[9],
        occurred_at=row[10],
        created_at=row[11],
        created_by=row[12] or None,
    )
