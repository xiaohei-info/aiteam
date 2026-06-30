"""企业级 usage/audit rollup + 软配额治理业务编排（M8，04 §6.5/§6.5.1，D13/D24）。

编排 repository（租户隔离）+ 脱敏摘要消费（F13 UsageSummaryUpload）+ 软配额治理动作。
tenant_id 全程经 TenantContext（D22）；跨租户因 RLS 不可见。

红线（D13/D24）：
- 消费端不存任何会话内容（message/prompt/token 明文/工具 IO 明细）；只接脱敏聚合摘要。
- 默认软配额：不每 run 强领 quota lease；治理动作只产出告警/限流**建议**，不强制阻断 run（D14）。
- 仅做本企业（租户内）汇总，不做跨企业汇总（跨企业归 O3 运营端）。
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict, Forbidden, NotFound, ValidationProblem

from .schemas import (
    AuditSummaryOut,
    QuotaEnforcementActionOut,
    QuotaPolicyIn,
    QuotaPolicyOut,
    RunEventIn,
    RunEventOut,
    UsageAggregateOut,
    UsageLedgerIn,
    UsageLedgerOut,
    UsageRollupOut,
)
from .usage_audit_quota_repository import (
    AuditSummaryRow,
    QuotaPolicyRow,
    UsageAuditQuotaRepository,
    UsageRollupRow,
)

# 配额策略写操作允许的企业角色（03 §9.7）。Member 只读。
_QUOTA_WRITE_ROLES = [
    EnterpriseRole.OWNER.value,
    EnterpriseRole.ENTERPRISE_ADMIN.value,
    EnterpriseRole.FINANCE_ADMIN.value,
]


class UsageAuditQuotaService:
    """usage/audit rollup 聚合 + 软配额治理编排。

    红线守卫：本服务不接收/存储任何会话内容；消费 UsageSummaryUpload 时只取脱敏聚合字段。
    """

    # UsageSummaryUpload / UsageSummary / AuditSummaryEvent 中**禁止**出现会话内容相关键
    # （消费时拒绝，D13 红线：消费端不存任何 message/prompt/token 明文）。
    _FORBIDDEN_CONTENT_KEYS = frozenset({
        "message", "messages", "prompt", "prompts", "content", "text",
        "tool_input", "tool_output", "raw_event", "completion", "response_text",
    })

    def __init__(self, repo: UsageAuditQuotaRepository):
        self._repo = repo

    # ---- 消费 F13 上报的脱敏 UsageSummaryUpload ----

    def ingest_upload(self, ctx: TenantContext, payload: dict) -> dict:
        """消费 A5 上报的 UsageSummaryUpload（只取脱敏摘要，落库聚合）。

        payload 形状对齐 shared.contracts.crosstier.UsageSummaryUpload：
            {tenant_id, usage: [UsageSummary...], audits: [AuditSummaryEvent...]}
        红线：拒绝任何含会话内容键的条目（D13）。
        """
        self._assert_tenant_matches(ctx, payload)
        usage_items = payload.get("usage") or []
        audit_items = payload.get("audits") or []
        usage_rows: list[UsageRollupRow] = []
        audit_rows: list[AuditSummaryRow] = []
        for item in usage_items:
            self._assert_no_conversation_content(item, kind="UsageSummary")
            usage_rows.append(self._repo.upsert_usage(ctx, payload=self._usage_payload(item)))
        for item in audit_items:
            self._assert_no_conversation_content(item, kind="AuditSummaryEvent")
            audit_rows.append(self._repo.upsert_audit(ctx, payload=self._audit_payload(item)))
        return {
            "usage_ingested": len(usage_rows),
            "audits_ingested": len(audit_rows),
        }

    def list_usage(self, ctx: TenantContext) -> list[UsageRollupOut]:
        return [_to_usage_out(r) for r in self._repo.list_usage(ctx)]

    def list_audits(self, ctx: TenantContext) -> list[AuditSummaryOut]:
        return [_to_audit_out(r) for r in self._repo.list_audits(ctx)]

    def aggregate_usage(
        self, ctx: TenantContext, *, window_start: datetime, window_end: datetime,
    ) -> UsageAggregateOut:
        agg = self._repo.aggregate_usage(
            ctx, window_start=window_start, window_end=window_end,
        )
        return UsageAggregateOut(
            rollup_count=agg["rollup_count"],
            run_count=agg["run_count"],
            token_total=agg["token_total"],
            cost_total=_to_decimal(agg["cost_total"]),
            error_count=agg["error_count"],
            duration_seconds_total=agg["duration_seconds_total"],
        )

    # ---- 软配额策略 CRUD（D24 默认 soft）----

    def create_quota(self, ctx: TenantContext, body: QuotaPolicyIn) -> QuotaPolicyOut:
        _ensure_can_write_quota(ctx)
        _assert_quota_neutral(body)
        if self._repo.get_quota_by_slug(ctx, policy_slug=body.policy_slug) is not None:
            raise Conflict("quota policy slug already exists in this tenant")
        row = self._repo.create_quota(
            ctx,
            policy_slug=body.policy_slug,
            display_name=body.display_name,
            scope=body.scope,
            target_ref=body.target_ref,
            window_start=body.window_start,
            window_end=body.window_end,
            dimensions=body.dimensions,
            enforcement=body.enforcement,
            status=body.status,
        )
        return _to_quota_out(row)

    def get_quota(self, ctx: TenantContext, *, policy_id: str) -> QuotaPolicyOut:
        return _to_quota_out(self._require_quota(ctx, policy_id))

    def update_quota(self, ctx: TenantContext, body: QuotaPolicyIn, *, policy_id: str) -> QuotaPolicyOut:
        _ensure_can_write_quota(ctx)
        _assert_quota_neutral(body)
        if self._require_quota(ctx, policy_id) is None:
            raise NotFound("quota policy not found in this tenant")
        row = self._repo.update_quota(
            ctx,
            policy_id=policy_id,
            display_name=body.display_name,
            scope=body.scope,
            target_ref=body.target_ref,
            window_start=body.window_start,
            window_end=body.window_end,
            dimensions=body.dimensions,
            enforcement=body.enforcement,
            status=body.status,
        )
        if row is None:  # RLS 下跨 tenant 不可见
            raise NotFound("quota policy not found in this tenant")
        return _to_quota_out(row)

    def delete_quota(self, ctx: TenantContext, *, policy_id: str) -> None:
        _ensure_can_write_quota(ctx)
        if not self._repo.delete_quota(ctx, policy_id=policy_id):
            raise NotFound("quota policy not found in this tenant")

    def list_quotas(self, ctx: TenantContext) -> list[QuotaPolicyOut]:
        return [_to_quota_out(r) for r in self._repo.list_quotas(ctx)]

    # ---- 软配额治理动作（D24：默认 soft，不阻断 run）----

    def evaluate_quota(
        self, ctx: TenantContext, *, policy_id: str,
        window_start: datetime, window_end: datetime,
    ) -> QuotaEnforcementActionOut:
        """评估配额并产出软治理动作（告警/限流建议），不强制阻断、不发 quota lease。

        D24：默认 soft——即使超阈也只产出 notify_owner/alert_threshold/suggest_throttle 等建议，
        不阻断本地执行（D14 离线可用性）。硬配额模式（enforcement=hard）才产出 block_new_runs
        建议，但仍非 lease（不破坏离线可用性在详设显式标记）。
        """
        policy = self._require_quota(ctx, policy_id)
        agg = self._repo.aggregate_usage(
            ctx, window_start=window_start, window_end=window_end,
        )
        dims = policy.dimensions or {}
        actions: list[str] = []
        severity = "info"
        detail_parts: list[str] = []
        cost_total = _to_decimal(agg["cost_total"])

        cost_cap = _to_decimal(dims.get("cost_cap_usd"))
        token_cap = dims.get("token_cap")
        run_cap = dims.get("run_cap")
        threshold = dims.get("alert_threshold")

        # 软告警：达阈值即 notify_owner + alert_threshold（不阻断）。
        if threshold is not None:
            ratio = _ratio(agg["run_count"], threshold) or _ratio(int(cost_total), threshold)
            if ratio is not None and ratio >= 1.0:
                actions.append("alert_threshold")
                severity = "warn"
                detail_parts.append(f"已达告警阈值 threshold={threshold}")

        if cost_cap is not None and cost_total >= cost_cap:
            actions.append("notify_owner")
            severity = "alert"
            detail_parts.append(f"成本 {cost_total} >= cap {cost_cap}")
        if token_cap is not None and agg["token_total"] >= token_cap:
            actions.append("notify_owner")
            if severity != "alert":
                severity = "warn"
            detail_parts.append(f"token {agg['token_total']} >= cap {token_cap}")
        if run_cap is not None and agg["run_count"] >= run_cap:
            actions.append("suggest_throttle")
            if severity != "alert":
                severity = "warn"
            detail_parts.append(f"run_count {agg['run_count']} >= cap {run_cap}")

        # 硬配额模式：追加 block_new_runs 建议（仍非 lease；详设须显式标记牺牲离线可用性）。
        if policy.enforcement == "hard" and actions:
            actions.append("block_new_runs")
            severity = "alert"

        if not actions:
            actions.append("within_budget")
            detail_parts.append("配额内，无治理动作")

        return QuotaEnforcementActionOut(
            policy_id=policy.policy_id,
            policy_slug=policy.policy_slug,
            enforcement=policy.enforcement,
            actions=actions,
            severity=severity,
            detail="; ".join(detail_parts) if detail_parts else None,
        )

    # ---- 红线守卫 ----

    def _assert_tenant_matches(self, ctx: TenantContext, payload: dict) -> None:
        """上传体 tenant_id 必须与当前身份一致（D22，防跨租户写入）。"""
        upload_tid = payload.get("tenant_id")
        if upload_tid is None:
            raise ValidationProblem("UsageSummaryUpload 缺少 tenant_id")
        if str(upload_tid) != str(ctx.tenant_id):
            raise Forbidden("上传体 tenant_id 与当前身份不一致")

    def _assert_no_conversation_content(self, item: dict, *, kind: str) -> None:
        """D13 红线：消费端不存任何会话内容。拒绝含会话内容键的条目。"""
        present = self._FORBIDDEN_CONTENT_KEYS & set(item.keys())
        if present:
            raise ValidationProblem(
                f"{kind} 含会话内容字段 {sorted(present)}，违反 D13（消费端不存会话内容）"
            )

    def _usage_payload(self, item: dict) -> dict:
        """从 UsageSummary 取脱敏聚合字段（对齐 shared.contracts.summary.UsageSummary）。"""
        return {
            "summary_id": item["summary_id"],
            "employee_id": item.get("employee_id"),
            "window_start": item["window_start"],
            "window_end": item["window_end"],
            "run_count": item.get("run_count", 0),
            "token_total": item.get("token_total", 0),
            "cost_total": item.get("cost_total", Decimal("0")),
            "error_count": item.get("error_count", 0),
            "duration_seconds_total": item.get("duration_seconds_total", 0),
        }

    def _audit_payload(self, item: dict) -> dict:
        """从 AuditSummaryEvent 取脱敏事件字段（对齐 shared.contracts.summary.AuditSummaryEvent）。"""
        return {
            "summary_id": item["summary_id"],
            "actor": item["actor"],
            "action": item["action"],
            "resource_type": item.get("resource_type"),
            "resource_id": item.get("resource_id"),
            "occurred_at": item["occurred_at"],
        }

    def _require_quota(self, ctx: TenantContext, policy_id: str) -> QuotaPolicyRow:
        row = self._repo.get_quota(ctx, policy_id=policy_id)
        if row is None:
            raise NotFound("quota policy not found in this tenant")
        return row


    # ---- run_event（runtime 归一事件脱敏归档）+ usage_ledger（逐 token 计费明细）----

    def append_run_event(self, ctx: TenantContext, body) -> dict | None:
        """归档单条 run-event。返回出参（含 event_id）；重复归档返回 None。"""
        self._assert_no_conversation_content(body.payload_json or {}, kind="RunEvent.payload_json")
        row = self._repo.append_run_event(
            ctx,
            run_id=body.run_id,
            cursor_no=body.cursor_no,
            event_type=body.event_type,
            source_type=body.source_type,
            source_id=body.source_id,
            team_task_id=body.team_task_id,
            employee_id=body.employee_id,
            event_ts=body.event_ts.isoformat() if body.event_ts else None,
            preview_text=body.preview_text or "",
            payload_json=body.payload_json,
        )
        return _to_run_event_out(row) if row is not None else None

    def list_run_events(self, ctx: TenantContext, *, run_id: str,
                        after_cursor: int = 0, limit: int = 100) -> dict:
        items = [_to_run_event_out(r) for r in self._repo.list_run_events(
            ctx, run_id=run_id, after_cursor=after_cursor, limit=limit,
        )]
        return {
            "run_id": run_id,
            "items": [i.model_dump(mode="json") for i in items],
            "max_cursor": self._repo.get_max_cursor(ctx, run_id=run_id),
        }

    def get_max_cursor(self, ctx: TenantContext, *, run_id: str) -> dict:
        return {"run_id": run_id, "max_cursor": self._repo.get_max_cursor(ctx, run_id=run_id)}

    def record_usage(self, ctx: TenantContext, body, *, mode: str = "upsert") -> dict:
        """记录逐 token 计费明细行。mode=upsert（默认，幂等）| create（严格新增）。"""
        payload = {
            "run_id": body.run_id,
            "employee_id": body.employee_id,
            "conversation_id": body.conversation_id,
            "input_tokens": body.input_tokens,
            "output_tokens": body.output_tokens,
            "total_tokens": body.total_tokens,
            "cost_cents": body.cost_cents,
            "source_type": body.source_type or "run_summary",
            "occurred_at": body.occurred_at.isoformat() if body.occurred_at else None,
            "created_by": body.created_by,
        }
        if mode == "create":
            row = self._repo.create_ledger(ctx, payload=payload)
        else:
            row = self._repo.upsert_ledger(ctx, payload=payload)
        return _to_ledger_out(row).model_dump(mode="json")

    def get_usage(self, ctx: TenantContext, *, run_id: str, source_type: str) -> dict | None:
        row = self._repo.get_ledger_by_run(ctx, run_id=run_id, source_type=source_type)
        return _to_ledger_out(row).model_dump(mode="json") if row is not None else None

    def list_usage_ledger(self, ctx: TenantContext, *, run_id: str | None = None,
                          employee_id: str | None = None,
                          period_start: str | None = None, period_end: str | None = None) -> list[dict]:
        rows = self._repo.list_ledger(
            ctx, run_id=run_id, employee_id=employee_id,
            period_start=period_start, period_end=period_end,
        )
        return [_to_ledger_out(r).model_dump(mode="json") for r in rows]


def _ensure_can_write_quota(ctx: TenantContext) -> None:
    """配额策略写操作鉴权（03 §9.7）。非 owner/enterprise_admin/finance_admin → 403。"""
    if not set(ctx.roles) & set(_QUOTA_WRITE_ROLES):
        raise Forbidden("quota write requires owner / enterprise_admin / finance_admin")


def _assert_quota_neutral(body: QuotaPolicyIn) -> None:
    """配额策略 dimensions 必须为中立维度，不含会话内容键（D13）。"""
    if not isinstance(body.dimensions, dict):
        raise ValidationProblem("dimensions 必须是对象")
    present = UsageAuditQuotaService._FORBIDDEN_CONTENT_KEYS & set(body.dimensions.keys())
    if present:
        raise ValidationProblem(
            f"dimensions 含会话内容字段 {sorted(present)}，违反 D13"
        )


def _to_decimal(value) -> Decimal:
    if value is None:
        return Decimal("0")
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def _ratio(numerator, denominator) -> float | None:
    try:
        d = float(denominator)
    except (TypeError, ValueError):
        return None
    if d <= 0:
        return None
    return float(numerator) / d


def _to_usage_out(row: UsageRollupRow) -> UsageRollupOut:
    return UsageRollupOut(
        rollup_id=row.rollup_id,
        summary_id=row.summary_id,
        employee_id=row.employee_id,
        window_start=row.window_start,
        window_end=row.window_end,
        run_count=row.run_count,
        token_total=row.token_total,
        cost_total=row.cost_total,
        error_count=row.error_count,
        duration_seconds_total=row.duration_seconds_total,
    )


def _to_audit_out(row: AuditSummaryRow) -> AuditSummaryOut:
    return AuditSummaryOut(
        event_id=row.event_id,
        summary_id=row.summary_id,
        actor=row.actor,
        action=row.action,
        resource_type=row.resource_type,
        resource_id=row.resource_id,
        occurred_at=row.occurred_at,
    )


def _to_quota_out(row: QuotaPolicyRow) -> QuotaPolicyOut:
    return QuotaPolicyOut(
        policy_id=row.policy_id,
        policy_slug=row.policy_slug,
        display_name=row.display_name,
        scope=row.scope,
        target_ref=row.target_ref,
        window_start=row.window_start,
        window_end=row.window_end,
        dimensions=row.dimensions,
        enforcement=row.enforcement,
        status=row.status,
        version=row.version,
    )


def _to_run_event_out(row) -> "RunEventOut":
    return RunEventOut(
        event_id=row.event_id,
        run_id=row.run_id,
        cursor_no=row.cursor_no,
        event_type=row.event_type,
        source_type=row.source_type,
        source_id=row.source_id,
        team_task_id=row.team_task_id,
        employee_id=row.employee_id,
        event_ts=row.event_ts,
        preview_text=row.preview_text,
        payload_json=row.payload_json,
        created_at=row.created_at,
    )


def _to_ledger_out(row) -> "UsageLedgerOut":
    return UsageLedgerOut(
        ledger_id=row.ledger_id,
        tenant_id=row.tenant_id,
        run_id=row.run_id,
        employee_id=row.employee_id,
        conversation_id=row.conversation_id,
        input_tokens=row.input_tokens,
        output_tokens=row.output_tokens,
        total_tokens=row.total_tokens,
        cost_cents=row.cost_cents,
        source_type=row.source_type,
        occurred_at=row.occurred_at,
        created_at=row.created_at,
        created_by=row.created_by,
    )


def build_usage_audit_quota_service(router: PgTenantRouter) -> UsageAuditQuotaService:
    return UsageAuditQuotaService(UsageAuditQuotaRepository(router))
