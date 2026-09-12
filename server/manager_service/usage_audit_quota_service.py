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
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict, Forbidden, NotFound, ValidationProblem

from .schemas import (
    AuditSummaryOut,
    QuotaEnforcementActionOut,
    QuotaPolicyIn,
    QuotaPolicyOut,
    UsageAggregateOut,
    UsageRollupOut,
)
from .usage_audit_quota_repository import (
    AuditSummaryRow,
    QuotaPolicyRow,
    UsageAuditQuotaRepository,
    UsageRollupRow,
)
from .usage_analytics_service import (
    UsageAnalyticsService,
    validate_aligned_window,
    validate_ingest_window,
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
    _USAGE_ALLOWED_KEYS = frozenset({
        "schema_version", "summary_id", "tenant_id", "member_id", "employee_id",
        "window_start", "window_end", "prompt_count", "settled_count", "error_count",
        "input_tokens", "output_tokens", "cache_tokens", "cost_minor", "currency",
        "duration_ms_total", "pricing_version", "pricing_status", "run_count",
        "token_total", "cost_total", "duration_seconds_total",
    })
    _AUDIT_ALLOWED_KEYS = frozenset({
        "summary_id", "tenant_id", "actor", "action", "resource_type", "resource_id",
        "occurred_at",
    })

    def __init__(self, repo: UsageAuditQuotaRepository):
        self._repo = repo

    # ---- 消费 F13 上报的脱敏 UsageSummaryUpload ----

    def ingest_upload(
        self,
        ctx: TenantContext,
        payload: dict,
        *,
        enterprise_id: str | None = None,
    ) -> dict:
        """Consume an Agent upload and retain every sanitized usage aggregate.

        Current Agent summaries are UTC-hour buckets and are atomically written
        with a durable Manager -> Operator delivery receipt by the PostgreSQL
        repository.  Compatibility fakes and older repository adapters still
        use ``upsert_usage``; they receive the same normalized aggregate.
        """

        upload_tenant = payload.get("tenant_id")
        if upload_tenant is not None and upload_tenant != ctx.tenant_id:
            raise Forbidden("usage upload tenant_id must match the authenticated tenant")
        usage_items = payload.get("usage") or []
        audit_items = payload.get("audits") or []
        if not isinstance(usage_items, list) or not isinstance(audit_items, list):
            raise ValidationProblem("usage and audits must be arrays")
        usage_rows: list[UsageRollupRow] = []
        audit_rows: list[AuditSummaryRow] = []
        for item in usage_items:
            self._assert_no_conversation_content(item, kind="UsageSummary")
            normalized = self._usage_payload(item, ctx=ctx)
            atomic = getattr(type(self._repo), "upsert_usage_with_delivery", None)
            if callable(atomic):
                row = self._repo.upsert_usage_with_delivery(
                    ctx, payload=normalized, enterprise_id=enterprise_id,
                )
            else:
                row = self._repo.upsert_usage(ctx, payload=normalized)
                enqueue = getattr(type(self._repo), "enqueue_usage_delivery", None)
                if callable(enqueue):
                    self._repo.enqueue_usage_delivery(
                        ctx, payload=normalized, enterprise_id=enterprise_id,
                    )
            usage_rows.append(row)
        for item in audit_items:
            self._assert_no_conversation_content(item, kind="AuditSummaryEvent")
            audit_rows.append(self._repo.upsert_audit(ctx, payload=self._audit_payload(item, ctx=ctx)))
        return {
            "usage_ingested": len(usage_rows),
            "audits_ingested": len(audit_rows),
        }

    def list_usage(
        self,
        ctx: TenantContext,
        *,
        member_id: str | None = None,
    ) -> list[UsageRollupOut]:
        if member_id is not None:
            _validate_member_filter(member_id)
            rows = self._repo.list_usage(ctx, member_id=member_id)
        else:
            rows = self._repo.list_usage(ctx)
        return [_to_usage_out(r) for r in rows]

    def list_audits(
        self,
        ctx: TenantContext,
        *,
        actor: str | None = None,
    ) -> list[AuditSummaryOut]:
        if actor is not None:
            _validate_opaque(actor, "member_id", max_length=256)
            rows = self._repo.list_audits(ctx, actor=actor)
        else:
            rows = self._repo.list_audits(ctx)
        return [_to_audit_out(r) for r in rows]

    def statistics(self, ctx: TenantContext, **filters: Any):
        """Return retained hourly statistics without consulting delivery state."""

        return UsageAnalyticsService(self._repo).statistics(ctx, **filters)

    def work_history(self, ctx: TenantContext, **filters: Any):
        """Return aggregate-only work metadata; Agent owns detailed history."""

        return UsageAnalyticsService(self._repo).work_history(ctx, **filters)

    def aggregate_usage(
        self,
        ctx: TenantContext,
        *,
        window_start: datetime,
        window_end: datetime,
        member_id: str | None = None,
    ) -> UsageAggregateOut:
        start, end = validate_aligned_window(window_start, window_end)
        assert start is not None and end is not None
        if member_id is None:
            agg = self._repo.aggregate_usage(
                ctx, window_start=start, window_end=end,
            )
        else:
            _validate_member_filter(member_id)
            agg = self._repo.aggregate_usage(
                ctx, window_start=start, window_end=end, member_id=member_id,
            )
        unknown_tokens = agg.get("unknown_pricing_tokens", 0)
        unknown_runs = agg.get("unknown_pricing_runs", 0)
        known_rollups = agg.get("known_pricing_rollups")
        unknown_rollups = agg.get("unknown_pricing_rollups")
        if known_rollups is None:
            # Compatibility adapters predate the pricing-rollup counts; retain
            # their established aggregate behavior while the SQL repository
            # reports exact known/unknown row counts.
            known_rollups = 1 if agg.get("rollup_count", 0) and not (unknown_tokens or unknown_runs) else 0
        if unknown_rollups is None:
            unknown_rollups = 1 if unknown_tokens or unknown_runs else 0
        known_cost = _to_decimal(agg["cost_total"]) if known_rollups else None
        total_cost = None if unknown_rollups else known_cost
        return UsageAggregateOut(
            rollup_count=agg["rollup_count"],
            run_count=agg["run_count"],
            token_total=agg["token_total"],
            cost_total=total_cost,
            known_cost_total=known_cost,
            unknown_pricing_tokens=unknown_tokens,
            unknown_pricing_runs=unknown_runs,
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

    def _assert_no_conversation_content(self, item: dict, *, kind: str) -> None:
        """D13 红线：消费端不存任何会话内容。"""
        if not isinstance(item, dict):
            raise ValidationProblem(f"{kind} must be an object")
        present = self._FORBIDDEN_CONTENT_KEYS & set(item.keys())
        if present:
            raise ValidationProblem(
                f"{kind} 含会话内容字段 {sorted(present)}，违反 D13（消费端不存会话内容）"
            )

    @staticmethod
    def _assert_allowed_keys(item: dict, allowed: frozenset[str], *, kind: str) -> None:
        unexpected = sorted(set(item) - allowed)
        if unexpected:
            raise ValidationProblem(
                f"{kind} 含未允许字段 {unexpected}；只接受有界脱敏摘要"
            )

    @staticmethod
    def _nonnegative_int(item: dict, field: str, default: int = 0) -> int:
        value = item.get(field, default)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValidationProblem(f"{field} must be a non-negative integer")
        return value

    def _validate_current_employee(
        self,
        ctx: TenantContext | None,
        *,
        employee_id: str | None,
        member_id: str | None,
        schema_version: str | None,
        current_summary: bool,
    ) -> None:
        """Fail closed when a current Agent summary names an inaccessible employee."""

        if ctx is None:
            return
        if employee_id is None:
            if schema_version == "1":
                raise ValidationProblem("current UsageSummary employee_id is required")
            return
        if not current_summary:
            # Unattributed legacy rows are retained without guessing historical
            # member/grant state; only current summaries require this check.
            return
        validator = getattr(type(self._repo), "employee_exists", None)
        granted = getattr(type(self._repo), "employee_granted_to_member", None)
        if not callable(validator) or not callable(granted):
            # Current summaries must never bypass the tenant/member grant seam.
            # Production UsageAuditQuotaRepository always implements both;
            # compatibility callers must use legacy unattributed summaries.
            raise Forbidden("usage employee authorization is not configured")
        try:
            if not validator(self._repo, ctx, employee_id=employee_id):
                raise Forbidden("usage employee is not in the authenticated tenant")
            if set(ctx.roles) & {EnterpriseRole.OWNER.value, EnterpriseRole.ENTERPRISE_ADMIN.value}:
                return
            if member_id is None or not granted(
                self._repo, ctx, employee_id=employee_id, member_id=member_id,
            ):
                raise Forbidden("usage employee is not granted to the authenticated member")
        except (ValueError, TypeError) as exc:
            raise ValidationProblem("usage employee/member IDs must be UUIDs") from exc

    def _usage_payload(self, item: dict, *, ctx: TenantContext | None = None) -> dict:
        """Normalize the aggregate-only Agent shape without filling attribution.

        ``member_id`` and ``employee_id`` are copied only when present.  In
        particular, a legacy row lacking either id is never assigned the
        currently authenticated request principal.
        """

        self._assert_allowed_keys(item, self._USAGE_ALLOWED_KEYS, kind="UsageSummary")
        if "summary_id" not in item or not isinstance(item["summary_id"], str) or not item["summary_id"].strip():
            raise ValidationProblem("UsageSummary summary_id is required")
        tenant_id = item.get("tenant_id")
        if tenant_id is not None and ctx is not None and tenant_id != ctx.tenant_id:
            raise Forbidden("UsageSummary tenant_id must match the authenticated tenant")
        if ctx is None:
            tenant_id = tenant_id or ""
        else:
            tenant_id = ctx.tenant_id
        employee_id = item.get("employee_id")
        if employee_id == "":
            employee_id = None
        if employee_id is not None and not isinstance(employee_id, str):
            raise ValidationProblem("employee_id must be a string or null")
        if employee_id is not None:
            _validate_opaque(employee_id, "employee_id", max_length=256)
        member_id = item.get("member_id")
        if member_id == "":
            member_id = None
        if member_id is not None and not isinstance(member_id, str):
            raise ValidationProblem("member_id must be a string or null")
        if member_id is not None:
            _validate_opaque(member_id, "member_id", max_length=256)
        if ctx is not None and member_id is not None and member_id != ctx.user_id:
            raise Forbidden("UsageSummary member_id must match the authenticated member")
        schema_version = item.get("schema_version")
        if schema_version is not None and schema_version != "1":
            raise ValidationProblem("unsupported UsageSummary schema_version")
        self._validate_current_employee(
            ctx,
            employee_id=employee_id,
            member_id=member_id,
            schema_version=schema_version,
            current_summary=(
                schema_version == "1"
                or member_id is not None
                or "pricing_status" in item
                or "prompt_count" in item
                or "input_tokens" in item
            ),
        )
        strict_hour = schema_version == "1" or member_id is not None
        start, end = validate_ingest_window(
            item.get("window_start"), item.get("window_end"), strict_hour=strict_hour,
        )
        currency = item.get("currency", "USD")
        if currency != "USD":
            raise ValidationProblem("usage currency must be USD")
        pricing_status = item.get("pricing_status", "unknown")
        if pricing_status not in {"known", "unknown"}:
            raise ValidationProblem("pricing_status must be known or unknown")
        pricing_version = item.get("pricing_version")
        if pricing_version is not None and (
            isinstance(pricing_version, bool) or not isinstance(pricing_version, int) or pricing_version < 1
        ):
            raise ValidationProblem("pricing_version must be a positive integer or null")
        run_count = self._nonnegative_int(item, "run_count")
        error_count = self._nonnegative_int(item, "error_count")
        raw_cost = item.get("cost_total")
        # A known pricing label without an actual cost is incomplete evidence;
        # normalize it to the same explicit unknown/null state as the Agent
        # contract rather than reconstructing Decimal(0).  A literal zero is
        # still valid when the cost field is present.
        if pricing_status == "known" and raw_cost is None:
            pricing_status = "unknown"
            pricing_version = None
            cost_total = None
        elif pricing_status == "unknown":
            # Unknown pricing never becomes a numeric Manager amount, including
            # legacy payloads that carried a compatibility zero/estimate.
            # Validate a supplied value before discarding it so malformed input
            # is still rejected rather than silently hidden.
            if raw_cost is not None:
                _to_decimal(raw_cost)
            pricing_version = None
            cost_total = None
        else:
            cost_total = _to_decimal(raw_cost)
        return {
            "summary_id": item["summary_id"],
            "tenant_id": tenant_id,
            "member_id": member_id,
            "employee_id": employee_id,
            "window_start": start,
            "window_end": end,
            "run_count": run_count,
            "token_total": self._nonnegative_int(item, "token_total"),
            "cost_total": cost_total,
            "pricing_version": pricing_version,
            "pricing_status": pricing_status,
            "currency": currency,
            "error_count": error_count,
            "duration_seconds_total": self._nonnegative_int(item, "duration_seconds_total"),
            "prompt_count": self._nonnegative_int(item, "prompt_count", run_count),
            "settled_count": self._nonnegative_int(item, "settled_count"),
            "input_tokens": self._nonnegative_int(item, "input_tokens"),
            "output_tokens": self._nonnegative_int(item, "output_tokens"),
            "cache_tokens": self._nonnegative_int(item, "cache_tokens"),
            "duration_ms_total": self._nonnegative_int(item, "duration_ms_total"),
        }

    def _audit_payload(self, item: dict, *, ctx: TenantContext | None = None) -> dict:
        """从 AuditSummaryEvent 取脱敏事件字段（对齐 shared.contracts.summary.AuditSummaryEvent）。"""
        self._assert_allowed_keys(item, self._AUDIT_ALLOWED_KEYS, kind="AuditSummaryEvent")
        if "summary_id" not in item or "actor" not in item or "action" not in item or "occurred_at" not in item:
            raise ValidationProblem("AuditSummaryEvent summary_id/actor/action/occurred_at are required")
        item_tenant = item.get("tenant_id")
        if item_tenant is not None and ctx is not None and item_tenant != ctx.tenant_id:
            raise Forbidden("AuditSummaryEvent tenant_id must match the authenticated tenant")
        summary_id = _validate_opaque(item["summary_id"], "summary_id", max_length=256)
        actor = _validate_opaque(item["actor"], "actor", max_length=256)
        action = _validate_opaque(item["action"], "action", max_length=128)
        resource_type = item.get("resource_type")
        if resource_type is not None:
            resource_type = _validate_opaque(resource_type, "resource_type", max_length=128)
        resource_id = item.get("resource_id")
        if resource_id is not None:
            resource_id = _validate_opaque(resource_id, "resource_id", max_length=256)
        return {
            "summary_id": summary_id,
            "actor": actor,
            "action": action,
            "resource_type": resource_type,
            "resource_id": resource_id,
            "occurred_at": item["occurred_at"],
        }

    def _require_quota(self, ctx: TenantContext, policy_id: str) -> QuotaPolicyRow:
        row = self._repo.get_quota(ctx, policy_id=policy_id)
        if row is None:
            raise NotFound("quota policy not found in this tenant")
        return row




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


def _validate_opaque(value: str, field: str, *, max_length: int) -> str:
    """Validate a bounded opaque identifier; reject free-form/control text."""

    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > max_length
        or any(char.isspace() or ord(char) < 0x20 or ord(char) == 0x7F for char in value)
    ):
        raise ValidationProblem(f"{field} must be a bounded opaque identifier")
    return value


def _validate_member_filter(member_id: str) -> None:
    _validate_opaque(member_id, "member_id", max_length=256)
    try:
        UUID(member_id)
    except (ValueError, TypeError) as exc:
        raise ValidationProblem("member_id must be a UUID") from exc


def _to_decimal(value) -> Decimal:
    if value is None:
        return Decimal("0")
    if isinstance(value, bool):
        raise ValidationProblem("cost_total must be a non-negative decimal")
    try:
        result = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValidationProblem("cost_total must be a non-negative decimal") from exc
    if not result.is_finite() or result < 0:
        raise ValidationProblem("cost_total must be a non-negative decimal")
    return result


def _ratio(numerator, denominator) -> float | None:
    try:
        d = float(denominator)
    except (TypeError, ValueError):
        return None
    if d <= 0:
        return None
    return float(numerator) / d


def _to_usage_out(row: UsageRollupRow) -> UsageRollupOut:
    pricing_status = row.pricing_status
    if pricing_status == "known" and row.cost_total is None:
        pricing_status = "unknown"
    return UsageRollupOut(
        rollup_id=row.rollup_id,
        summary_id=row.summary_id,
        employee_id=row.employee_id,
        member_id=row.member_id,
        window_start=row.window_start,
        window_end=row.window_end,
        run_count=row.run_count,
        token_total=row.token_total,
        cost_total=None if pricing_status == "unknown" else row.cost_total,
        pricing_version=row.pricing_version if pricing_status == "known" else None,
        pricing_status=pricing_status,
        currency=row.currency,
        error_count=row.error_count,
        duration_seconds_total=row.duration_seconds_total,
        prompt_count=row.prompt_count,
        settled_count=row.settled_count,
        input_tokens=row.input_tokens,
        output_tokens=row.output_tokens,
        cache_tokens=row.cache_tokens,
        duration_ms_total=row.duration_ms_total,
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


def build_usage_audit_quota_service(router: PgTenantRouter) -> UsageAuditQuotaService:
    return UsageAuditQuotaService(UsageAuditQuotaRepository(router))
