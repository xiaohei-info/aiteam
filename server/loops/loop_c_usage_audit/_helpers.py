"""闭环 C Service Integration 共享测试替身（无 PG，全内存）。

替身只承接契约形状（UsageSummaryUpload / EnterpriseRollupUpload），不真连任何对端；
真实跨端链路在 tests/integration/ 下走真 PG + ServiceClient，本包聚焦三端编排闭环的可观测断言。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal

from shared.contracts.crosstier import UsageSummaryUpload
from shared.contracts.tenancy import TenantContext

from manager_service.schemas import QuotaPolicyIn
from manager_service.usage_audit_quota_repository import (
    AuditSummaryRow,
    QuotaPolicyRow,
    UsageRollupRow,
)


def _dec(v) -> Decimal:
    if v is None:
        return Decimal("0")
    if isinstance(v, Decimal):
        return v
    return Decimal(str(v))


def _dt(v):
    if isinstance(v, datetime):
        return v
    if isinstance(v, str):
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    return v


def tenant_ctx(tenant_id: str = "t-1", *, roles=None, enterprise_id=None) -> TenantContext:
    return TenantContext(
        tenant_id=tenant_id,
        user_id="owner-1",
        roles=roles or ["owner"],
        enterprise_id=enterprise_id,
    )


# ---- Agent -> Manager 用量上报客户端替身 ----


class CapturingUsageClient:
    """捕获 Agent 上报到 Manager 的脱敏摘要（不真连）。"""

    def __init__(self) -> None:
        self.uploads: list[UsageSummaryUpload] = []
        self.keys: list[str] = []

    def upload(self, payload: UsageSummaryUpload, *, idempotency_key: str) -> None:
        self.uploads.append(payload)
        self.keys.append(idempotency_key)


class RaisingUsageClient:
    """永远上报失败：验证 outbox 留 pending/retry、不阻断本地 run（D14）。"""

    def __init__(self, exc: Exception | None = None) -> None:
        self._exc = exc or RuntimeError("manager unreachable")
        self.attempts = 0

    def upload(self, payload: UsageSummaryUpload, *, idempotency_key: str) -> None:
        self.attempts += 1
        raise self._exc


# ---- Manager -> Operator rollup 上报客户端替身 ----


class CapturingRollupClient:
    """捕获 Manager 上报到 Operator 的企业级 rollup（不真连）。"""

    def __init__(self) -> None:
        self.uploads: list = []  # list[EnterpriseRollupUpload]
        self.keys: list[str] = []

    def upload(self, payload, *, idempotency_key: str) -> None:
        self.uploads.append(payload)
        self.keys.append(idempotency_key)


class RaisingRollupClient:
    def __init__(self, exc: Exception | None = None) -> None:
        self._exc = exc or RuntimeError("operator unreachable")

    def upload(self, payload, *, idempotency_key: str) -> None:
        raise self._exc


# ---- Manager usage/audit/quota 内存伪 repo（模拟 RLS 跨租户不可见，D22）----


class FakeUsageAuditRepo:
    """按 tenant_id 分桶的内存伪 repo；tenant_id 只从 ctx 读（D22）。"""

    def __init__(self) -> None:
        self._usage: dict[str, dict[str, UsageRollupRow]] = {}
        self._audit: dict[str, dict[str, AuditSummaryRow]] = {}
        self._quota: dict[str, dict[str, QuotaPolicyRow]] = {}

    def _u(self, ctx):
        return self._usage.setdefault(ctx.tenant_id, {})

    def _a(self, ctx):
        return self._audit.setdefault(ctx.tenant_id, {})

    def _q(self, ctx):
        return self._quota.setdefault(ctx.tenant_id, {})

    def upsert_usage(self, ctx, *, payload):
        b = self._u(ctx)
        key = payload["summary_id"]
        row = UsageRollupRow(
            rollup_id=str(uuid.uuid4()), tenant_id=ctx.tenant_id, summary_id=key,
            employee_id=payload.get("employee_id"),
            window_start=_dt(payload["window_start"]), window_end=_dt(payload["window_end"]),
            run_count=payload.get("run_count", 0), token_total=payload.get("token_total", 0),
            cost_total=_dec(payload.get("cost_total", 0)),
            error_count=payload.get("error_count", 0),
            duration_seconds_total=payload.get("duration_seconds_total", 0),
            received_at=datetime.now(timezone.utc),
        )
        b[key] = row
        return row

    def list_usage(self, ctx):
        return list(self._u(ctx).values())

    def aggregate_usage(self, ctx, *, window_start, window_end):
        rows = [r for r in self._u(ctx).values()
                if r.window_start >= window_start and r.window_end <= window_end]
        return {
            "rollup_count": len(rows),
            "run_count": sum(r.run_count for r in rows),
            "token_total": sum(r.token_total for r in rows),
            "cost_total": sum((r.cost_total for r in rows), Decimal("0")),
            "error_count": sum(r.error_count for r in rows),
            "duration_seconds_total": sum(r.duration_seconds_total for r in rows),
        }

    def upsert_audit(self, ctx, *, payload):
        b = self._a(ctx)
        key = payload["summary_id"]
        row = AuditSummaryRow(
            event_id=str(uuid.uuid4()), tenant_id=ctx.tenant_id, summary_id=key,
            actor=payload["actor"], action=payload["action"],
            resource_type=payload.get("resource_type"), resource_id=payload.get("resource_id"),
            occurred_at=_dt(payload["occurred_at"]), received_at=datetime.now(timezone.utc),
        )
        b[key] = row
        return row

    def list_audits(self, ctx):
        return list(self._a(ctx).values())

    def create_quota(self, ctx, *, policy_slug, display_name, scope, target_ref,
                     window_start, window_end, dimensions, enforcement, status):
        row = QuotaPolicyRow(
            policy_id=str(uuid.uuid4()), tenant_id=ctx.tenant_id, policy_slug=policy_slug,
            display_name=display_name, scope=scope, target_ref=target_ref,
            window_start=window_start, window_end=window_end, dimensions=dict(dimensions),
            enforcement=enforcement, status=status, version=1,
            created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
        )
        self._q(ctx)[row.policy_id] = row
        return row

    def get_quota(self, ctx, *, policy_id):
        return self._q(ctx).get(policy_id)

    def get_quota_by_slug(self, ctx, *, policy_slug):
        for r in self._q(ctx).values():
            if r.policy_slug == policy_slug:
                return r
        return None

    def update_quota(self, ctx, *, policy_id, display_name, scope, target_ref,
                     window_start, window_end, dimensions, enforcement, status):
        b = self._q(ctx)
        old = b.get(policy_id)
        if old is None:
            return None
        row = QuotaPolicyRow(
            policy_id=policy_id, tenant_id=ctx.tenant_id, policy_slug=old.policy_slug,
            display_name=display_name, scope=scope, target_ref=target_ref,
            window_start=window_start, window_end=window_end, dimensions=dict(dimensions),
            enforcement=enforcement, status=status, version=old.version + 1,
            created_at=old.created_at, updated_at=datetime.now(timezone.utc),
        )
        b[policy_id] = row
        return row

    def delete_quota(self, ctx, *, policy_id):
        return self._q(ctx).pop(policy_id, None) is not None

    def list_quotas(self, ctx):
        return list(self._q(ctx).values())


def quota_in(slug="cost-cap", *, enforcement="soft", dimensions=None, window=None) -> QuotaPolicyIn:
    w = window or (datetime(2026, 6, 1, tzinfo=timezone.utc), datetime(2026, 6, 30, tzinfo=timezone.utc))
    return QuotaPolicyIn(
        policy_slug=slug,
        display_name=slug,
        scope="tenant",
        target_ref=None,
        window_start=w[0],
        window_end=w[1],
        dimensions=dimensions or {},
        enforcement=enforcement,
        status="active",
    )
