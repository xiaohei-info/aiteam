"""usage_audit_quota_service.py branch coverage fill (issue #234, target >=90%)."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from manager_service.usage_audit_quota_repository import (
    AuditSummaryRow,
    QuotaPolicyRow,
    UsageRollupRow,
)
from manager_service.usage_audit_quota_service import (
    UsageAuditQuotaService,
    _ratio,
    _to_decimal,
    build_usage_audit_quota_service,
)
from shared.contracts.tenancy import TenantContext
from shared.errors import NotFound, ValidationProblem


class _FakeRepo:
    def __init__(self):
        self._usage = {}
        self._audit = {}
        self._quota = {}

    def _bq(self, ctx):
        return self._quota.setdefault(ctx.tenant_id, {})

    def _bu(self, ctx):
        return self._usage.setdefault(ctx.tenant_id, {})

    def _ba(self, ctx):
        return self._audit.setdefault(ctx.tenant_id, {})

    def upsert_usage(self, ctx, *, payload):
        row = UsageRollupRow(
            rollup_id=str(uuid.uuid4()), tenant_id=ctx.tenant_id,
            summary_id=payload["summary_id"], employee_id=payload.get("employee_id"),
            window_start=payload["window_start"], window_end=payload["window_end"],
            run_count=payload.get("run_count", 0), token_total=payload.get("token_total", 0),
            cost_total=Decimal(str(payload.get("cost_total", 0))),
            error_count=payload.get("error_count", 0),
            duration_seconds_total=payload.get("duration_seconds_total", 0),
            received_at=datetime.now(timezone.utc),
        )
        self._bu(ctx)[row.summary_id] = row
        return row

    def list_usage(self, ctx):
        return list(self._bu(ctx).values())

    def aggregate_usage(self, ctx, *, window_start, window_end):
        rows = [r for r in self._bu(ctx).values()
                if r.window_start >= window_start and r.window_end <= window_end]
        return {
            "rollup_count": len(rows), "run_count": sum(r.run_count for r in rows),
            "token_total": sum(r.token_total for r in rows),
            "cost_total": sum(r.cost_total for r in rows),
            "error_count": sum(r.error_count for r in rows),
            "duration_seconds_total": sum(r.duration_seconds_total for r in rows),
        }

    def upsert_audit(self, ctx, *, payload):
        row = AuditSummaryRow(
            event_id=str(uuid.uuid4()), tenant_id=ctx.tenant_id,
            summary_id=payload["summary_id"], actor=payload["actor"],
            action=payload["action"], resource_type=payload.get("resource_type"),
            resource_id=payload.get("resource_id"),
            occurred_at=payload["occurred_at"], received_at=datetime.now(timezone.utc),
        )
        self._ba(ctx)[row.summary_id] = row
        return row

    def list_audits(self, ctx):
        return list(self._ba(ctx).values())

    def create_quota(self, ctx, *, policy_slug, display_name, scope, target_ref,
                     window_start, window_end, dimensions, enforcement, status):
        row = QuotaPolicyRow(
            policy_id=str(uuid.uuid4()), tenant_id=ctx.tenant_id, policy_slug=policy_slug,
            display_name=display_name, scope=scope, target_ref=target_ref,
            window_start=window_start, window_end=window_end, dimensions=dict(dimensions),
            enforcement=enforcement, status=status, version=1,
            created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
        )
        self._bq(ctx)[row.policy_id] = row
        return row

    def get_quota(self, ctx, *, policy_id):
        return self._bq(ctx).get(policy_id)

    def get_quota_by_slug(self, ctx, *, policy_slug):
        for r in self._bq(ctx).values():
            if r.policy_slug == policy_slug:
                return r
        return None

    def update_quota(self, ctx, *, policy_id, display_name, scope, target_ref,
                     window_start, window_end, dimensions, enforcement, status):
        b = self._bq(ctx)
        old = b.get(policy_id)
        if old is None:
            return None
        row = QuotaPolicyRow(
            policy_id=old.policy_id, tenant_id=old.tenant_id, policy_slug=old.policy_slug,
            display_name=display_name, scope=scope, target_ref=target_ref,
            window_start=window_start, window_end=window_end, dimensions=dict(dimensions),
            enforcement=enforcement, status=status, version=old.version + 1,
            created_at=old.created_at, updated_at=datetime.now(timezone.utc),
        )
        b[policy_id] = row
        return row

    def delete_quota(self, ctx, *, policy_id):
        return self._bq(ctx).pop(policy_id, None) is not None

    def list_quotas(self, ctx):
        return list(self._bq(ctx).values())


class _RlsNoneRepo(_FakeRepo):
    """update_quota always returns None to test the row is None branch."""

    def update_quota(self, ctx, *, policy_id, **kw):
        return None


def _ctx(tid="t-a", roles=None):
    return TenantContext(tenant_id=tid, user_id="u", roles=roles or ["owner"])


def _quota_body(**overrides):
    from manager_service.schemas import QuotaPolicyIn
    base = {
        "policy_slug": "q1",
        "window_start": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "window_end": datetime(2026, 2, 1, tzinfo=timezone.utc),
        "dimensions": {"cost_cap_usd": 100},
    }
    base.update(overrides)
    return QuotaPolicyIn(**base)


def _make_policy(repo, ctx, **dim_kw):
    dims = {"cost_cap_usd": 100, "token_cap": 1000000, "run_cap": 500}
    dims.update(dim_kw)
    return repo.create_quota(
        ctx, policy_slug="p1", display_name="P1", scope="tenant", target_ref=None,
        window_start=datetime(2026, 1, 1, tzinfo=timezone.utc),
        window_end=datetime(2026, 2, 1, tzinfo=timezone.utc),
        dimensions=dims, enforcement="soft", status="active",
    )


def _usage_item(summary_id="s1", **kw):
    base = {
        "summary_id": summary_id, "employee_id": None,
        "window_start": datetime(2026, 1, 10, tzinfo=timezone.utc),
        "window_end": datetime(2026, 1, 11, tzinfo=timezone.utc),
        "run_count": 5, "token_total": 10000, "cost_total": Decimal("1.5"),
        "error_count": 1, "duration_seconds_total": 600,
    }
    base.update(kw)
    return base


def _upload(tid, *, usage=None, audits=None):
    return {"tenant_id": tid, "usage": usage or [], "audits": audits or []}


WS = datetime(2026, 1, 1, tzinfo=timezone.utc)
WE = datetime(2026, 2, 1, tzinfo=timezone.utc)


def test_get_quota_not_found():
    svc = UsageAuditQuotaService(_FakeRepo())
    with pytest.raises(NotFound):
        svc.get_quota(_ctx(), policy_id="nonexistent")


def test_evaluate_quota_threshold_alert_via_run_count():
    repo = _FakeRepo()
    svc = UsageAuditQuotaService(repo)
    ctx = _ctx()
    policy = _make_policy(repo, ctx, alert_threshold=5)
    repo.upsert_usage(ctx, payload=_usage_item("s1", run_count=6))
    action = svc.evaluate_quota(ctx, policy_id=policy.policy_id, window_start=WS, window_end=WE)
    assert "alert_threshold" in action.actions
    assert action.severity == "warn"


def test_evaluate_quota_threshold_alert_via_cost():
    """threshold branch: run_count ratio < 1 but cost ratio >= 1 -> alert_threshold."""
    repo = _FakeRepo()
    svc = UsageAuditQuotaService(repo)
    ctx = _ctx()
    # No cost_cap/token_cap/run_cap so only alert_threshold triggers
    policy = repo.create_quota(
        ctx, policy_slug="tp", display_name="T", scope="tenant", target_ref=None,
        window_start=WS, window_end=WE,
        dimensions={"alert_threshold": 100, "cost_cap_usd": 1000}, enforcement="soft", status="active",
    )
    # run_count=6, threshold=100 -> ratio=0.06 < 1; cost=150 -> ratio=1.5 >= 1
    repo.upsert_usage(ctx, payload=_usage_item("s1", run_count=0, cost_total=Decimal("150")))
    action = svc.evaluate_quota(ctx, policy_id=policy.policy_id, window_start=WS, window_end=WE)
    assert "alert_threshold" in action.actions
def test_evaluate_quota_threshold_not_reached():
    repo = _FakeRepo()
    svc = UsageAuditQuotaService(repo)
    ctx = _ctx()
    policy = _make_policy(repo, ctx, alert_threshold=100)
    repo.upsert_usage(ctx, payload=_usage_item("s1", run_count=1))
    action = svc.evaluate_quota(ctx, policy_id=policy.policy_id, window_start=WS, window_end=WE)
    assert "alert_threshold" not in action.actions
    assert "within_budget" in action.actions


def test_evaluate_quota_cost_cap_alert():
    repo = _FakeRepo()
    svc = UsageAuditQuotaService(repo)
    ctx = _ctx()
    policy = _make_policy(repo, ctx)
    repo.upsert_usage(ctx, payload=_usage_item("s1", cost_total=Decimal("150")))
    action = svc.evaluate_quota(ctx, policy_id=policy.policy_id, window_start=WS, window_end=WE)
    assert "notify_owner" in action.actions
    assert action.severity == "alert"


def test_evaluate_quota_token_cap_warn():
    repo = _FakeRepo()
    svc = UsageAuditQuotaService(repo)
    ctx = _ctx()
    policy = _make_policy(repo, ctx, token_cap=1000)
    repo.upsert_usage(ctx, payload=_usage_item("s1", token_total=2000, cost_total=Decimal("0")))
    action = svc.evaluate_quota(ctx, policy_id=policy.policy_id, window_start=WS, window_end=WE)
    assert "notify_owner" in action.actions
    assert action.severity == "warn"


def test_evaluate_quota_run_cap_suggest_throttle():
    repo = _FakeRepo()
    svc = UsageAuditQuotaService(repo)
    ctx = _ctx()
    policy = _make_policy(repo, ctx, run_cap=3, cost_cap_usd=10)
    repo.upsert_usage(ctx, payload=_usage_item("s1", run_count=5, cost_total=Decimal("0")))
    action = svc.evaluate_quota(ctx, policy_id=policy.policy_id, window_start=WS, window_end=WE)
    assert "suggest_throttle" in action.actions
    assert action.severity == "warn"


def test_evaluate_quota_hard_no_actions():
    repo = _FakeRepo()
    svc = UsageAuditQuotaService(repo)
    ctx = _ctx()
    policy = repo.create_quota(
        ctx, policy_slug="hp", display_name="H", scope="tenant", target_ref=None,
        window_start=WS, window_end=WE,
        dimensions={"cost_cap_usd": 1000}, enforcement="hard", status="active",
    )
    repo.upsert_usage(ctx, payload=_usage_item("s1", run_count=1, cost_total=Decimal("1")))
    action = svc.evaluate_quota(ctx, policy_id=policy.policy_id, window_start=WS, window_end=WE)
    assert action.enforcement == "hard"
    assert "block_new_runs" not in action.actions
    assert "within_budget" in action.actions


def test_evaluate_quota_not_found():
    svc = UsageAuditQuotaService(_FakeRepo())
    with pytest.raises(NotFound):
        svc.evaluate_quota(_ctx(), policy_id="nope", window_start=WS, window_end=WE)


def test_evaluate_quota_detail_parts():
    repo = _FakeRepo()
    svc = UsageAuditQuotaService(repo)
    ctx = _ctx()
    policy = _make_policy(repo, ctx, run_cap=1, token_cap=1)
    repo.upsert_usage(ctx, payload=_usage_item("s1", run_count=5, token_total=10, cost_total=Decimal("0")))
    action = svc.evaluate_quota(ctx, policy_id=policy.policy_id, window_start=WS, window_end=WE)
    assert action.detail is not None
    assert ";" in action.detail


def test_evaluate_quota_within_budget_detail_not_none():
    repo = _FakeRepo()
    svc = UsageAuditQuotaService(repo)
    ctx = _ctx()
    policy = _make_policy(repo, ctx)
    action = svc.evaluate_quota(ctx, policy_id=policy.policy_id, window_start=WS, window_end=WE)
    assert action.actions == ["within_budget"]
    assert action.detail is not None


def test_update_quota_rls_returns_none():
    repo = _RlsNoneRepo()
    svc = UsageAuditQuotaService(repo)
    ctx = _ctx()
    created = repo.create_quota(
        ctx, policy_slug="p1", display_name="P", scope="tenant", target_ref=None,
        window_start=WS, window_end=WE,
        dimensions={"cost_cap_usd": 100}, enforcement="soft", status="active",
    )
    with pytest.raises(NotFound):
        svc.update_quota(ctx, _quota_body(policy_slug="p1", display_name="X2"), policy_id=created.policy_id)


def test_quota_neutral_non_dict_dimensions():
    from unittest.mock import MagicMock
    from manager_service.usage_audit_quota_service import _assert_quota_neutral
    body = MagicMock()
    body.dimensions = "not-a-dict"
    with pytest.raises(ValidationProblem):
        _assert_quota_neutral(body)


def test_to_decimal_none():
    assert _to_decimal(None) == Decimal("0")

def test_to_decimal_decimal_passthrough():
    d = Decimal("1.5")
    assert _to_decimal(d) == d

def test_to_decimal_from_int():
    assert _to_decimal(42) == Decimal("42")

def test_to_decimal_from_string():
    assert _to_decimal("3.14") == Decimal("3.14")


def test_ratio_type_error():
    assert _ratio(10, "not-a-number") is None

def test_ratio_value_error():
    assert _ratio(10, object()) is None

def test_ratio_zero_denominator():
    assert _ratio(10, 0) is None

def test_ratio_negative_denominator():
    assert _ratio(10, -1) is None

def test_ratio_valid():
    assert _ratio(10, 2) == 5.0


def test_build_usage_audit_quota_service():
    from shared.db import PgTenantRouter
    svc = build_usage_audit_quota_service(PgTenantRouter("postgresql://localhost/test"))
    assert isinstance(svc, UsageAuditQuotaService)


def test_list_quotas_via_service():
    repo = _FakeRepo()
    svc = UsageAuditQuotaService(repo)
    ctx = _ctx()
    _make_policy(repo, ctx)
    quotas = svc.list_quotas(ctx)
    assert len(quotas) == 1
    assert quotas[0].policy_slug == "p1"


def test_list_usage_maps_rows():
    repo = _FakeRepo()
    svc = UsageAuditQuotaService(repo)
    ctx = _ctx()
    svc.ingest_upload(ctx, _upload(ctx.tenant_id, usage=[_usage_item("s1")]))
    usages = svc.list_usage(ctx)
    assert len(usages) == 1
    assert usages[0].run_count == 5


def test_list_audits_maps_rows():
    repo = _FakeRepo()
    svc = UsageAuditQuotaService(repo)
    ctx = _ctx()
    audit_item = {
        "summary_id": "a1", "actor": "m", "action": "login",
        "resource_type": "expert", "resource_id": "e1",
        "occurred_at": datetime(2026, 1, 10, tzinfo=timezone.utc),
    }
    svc.ingest_upload(ctx, _upload(ctx.tenant_id, audits=[audit_item]))
    audits = svc.list_audits(ctx)
    assert len(audits) == 1
    assert audits[0].action == "login"


def test_aggregate_usage_maps_output():
    repo = _FakeRepo()
    svc = UsageAuditQuotaService(repo)
    ctx = _ctx()
    svc.ingest_upload(ctx, _upload(ctx.tenant_id, usage=[_usage_item("s1")]))
    agg = svc.aggregate_usage(ctx, window_start=WS, window_end=WE)
    assert agg.run_count == 5
    assert agg.rollup_count == 1
