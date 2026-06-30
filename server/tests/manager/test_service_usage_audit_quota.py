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

# ---- run_event / usage_ledger (issue #292) ----

import uuid
from datetime import datetime, timezone

import pytest

from manager_service.schemas import RunEventIn, RunEventOut, UsageLedgerIn, UsageLedgerOut
from manager_service.usage_audit_quota_service import (
    UsageAuditQuotaService,
    _to_run_event_out,
    _to_ledger_out,
)
from manager_service.usage_audit_quota_repository import (
    RunEventRow,
    UsageLedgerRow,
)
from shared.contracts.tenancy import TenantContext
from shared.errors import ValidationProblem


def _rr(eid="e-1", tid="t-1", rid="r-1", cursor=1, et="step_start", st="session",
        sid="s-1", tt=None, emp=None, ets=None, pv="step",
        payload=None, ca=None):
    return RunEventRow(eid, tid, rid, cursor, et, st, sid, tt, emp,
                       ets or datetime.now(timezone.utc), pv, payload or {"k": "v"},
                       ca or datetime.now(timezone.utc))


def _lr(lid="l-1", tid="t-1", rid="r-1", emp="emp-1", conv=None, it=100, ot=200,
        tt=300, cc=5, src="run_summary", occ=None, ca=None, by="svc"):
    return UsageLedgerRow(lid, tid, rid, emp, conv, it, ot, tt, cc, src,
                          occ or datetime.now(timezone.utc),
                          ca or datetime.now(timezone.utc), by)


class _FakeUsageRepo(_FakeRepo):
    def __init__(self):
        super().__init__()
        self._runs: dict[str, dict[int, RunEventRow]] = {}
        self._ledgers: dict[str, UsageLedgerRow] = {}

    def append_run_event(self, ctx, **kw):
        rid = kw["run_id"]
        runs = self._runs.setdefault(rid, {})
        if kw["cursor_no"] in runs:
            return None  # dedupe
        row = _rr(eid=uuid.uuid4().hex[:8], rid=rid, cursor=kw["cursor_no"],
                  et=kw.get("event_type", "step_start"),
                  st=kw.get("source_type", "session"), sid=kw.get("source_id", "s"))
        runs[kw["cursor_no"]] = row
        return row

    def list_run_events(self, ctx, *, run_id, after_cursor=0, limit=100):
        runs = self._runs.get(run_id, {})
        return sorted((r for r in runs.values() if r.cursor_no > after_cursor),
                      key=lambda r: r.cursor_no)[:limit]

    def get_max_cursor(self, ctx, *, run_id):
        runs = self._runs.get(run_id, {})
        return max(runs.keys(), default=0) if runs else 0

    def get_latest_run_event(self, ctx, *, run_id):
        runs = self._runs.get(run_id, {})
        if not runs:
            return None
        return runs[max(runs.keys())]

    def create_ledger(self, ctx, *, payload):
        key = f"{payload['run_id']}:{payload.get('source_type', 'run_summary')}"
        self._ledgers[key] = _lr(
            lid=uuid.uuid4().hex[:8], rid=payload["run_id"], emp=payload["employee_id"],
            conv=payload.get("conversation_id"), it=payload.get("input_tokens", 0),
            ot=payload.get("output_tokens", 0), tt=payload.get("total_tokens", 0),
            cc=payload.get("cost_cents", 0),
            src=payload.get("source_type", "run_summary"),
            by=payload.get("created_by"),
        )
        return self._ledgers[key]

    def upsert_ledger(self, ctx, *, payload):
        return self.create_ledger(ctx, payload=payload)

    def get_ledger_by_run(self, ctx, *, run_id, source_type):
        return self._ledgers.get(f"{run_id}:{source_type}")

    def list_ledger(self, ctx, **kw):
        rows = list(self._ledgers.values())
        if kw.get("run_id"):
            rows = [r for r in rows if r.run_id == kw["run_id"]]
        if kw.get("employee_id"):
            rows = [r for r in rows if r.employee_id == kw["employee_id"]]
        return rows


def _uctx(tid="t-u"):
    return TenantContext(tenant_id=tid, user_id="u", roles=["owner"])


def test_to_run_event_out_maps_row():
    out = _to_run_event_out(_rr())
    assert isinstance(out, RunEventOut)
    assert out.event_id == "e-1" and out.cursor_no == 1
    assert out.payload_json == {"k": "v"}


def test_to_ledger_out_maps_row():
    out = _to_ledger_out(_lr(it=100, ot=200, cc=9))
    assert isinstance(out, UsageLedgerOut)
    assert out.input_tokens == 100 and out.output_tokens == 200 and out.cost_cents == 9


def test_append_run_event_happy():
    svc = UsageAuditQuotaService(_FakeUsageRepo())
    body = RunEventIn(run_id="r-1", cursor_no=1, event_type="step_start",
                      source_type="session", source_id="s-1",
                      payload_json={"x": 1})
    out = svc.append_run_event(_uctx(), body)
    assert out is not None and out.run_id == "r-1"


def test_append_run_event_dedupe_returns_none_on_repeat():
    svc = UsageAuditQuotaService(_FakeUsageRepo())
    body = RunEventIn(run_id="r-1", cursor_no=1, event_type="step_start",
                      source_type="session", source_id="s-1")
    assert svc.append_run_event(_uctx("a"), body) is not None
    assert svc.append_run_event(_uctx("b"), body) is None


def test_append_run_event_rejects_conversation_content():
    svc = UsageAuditQuotaService(_FakeUsageRepo())
    body = RunEventIn(run_id="r-1", cursor_no=1, event_type="step_start",
                      source_type="session", source_id="s-1",
                      payload_json={"prompt": "secret"})
    with pytest.raises(ValidationProblem):
        svc.append_run_event(_uctx(), body)


def test_list_run_events_with_max_cursor():
    svc = UsageAuditQuotaService(_FakeUsageRepo())
    ctx = _uctx()
    for c in (1, 2, 3):
        svc.append_run_event(ctx, RunEventIn(
            run_id="r-1", cursor_no=c, event_type="step_start",
            source_type="session", source_id="s-1"))
    data = svc.list_run_events(ctx, run_id="r-1")
    assert data["max_cursor"] == 3
    assert [i["cursor_no"] for i in data["items"]] == [1, 2, 3]


def test_list_run_events_after_cursor_excludes_lower():
    svc = UsageAuditQuotaService(_FakeUsageRepo())
    ctx = _uctx()
    for c in (1, 2, 3, 4):
        svc.append_run_event(ctx, RunEventIn(
            run_id="r-1", cursor_no=c, event_type="step_start",
            source_type="session", source_id="s-1"))
    data = svc.list_run_events(ctx, run_id="r-1", after_cursor=2)
    assert [i["cursor_no"] for i in data["items"]] == [3, 4]


def test_get_max_cursor_zero_when_empty():
    svc = UsageAuditQuotaService(_FakeUsageRepo())
    assert svc.get_max_cursor(_uctx(), run_id="r-1") == {"run_id": "r-1", "max_cursor": 0}


def test_record_usage_upsert_and_get():
    svc = UsageAuditQuotaService(_FakeUsageRepo())
    ctx = _uctx()
    body = UsageLedgerIn(run_id="r-1", employee_id="emp-1",
                        input_tokens=100, output_tokens=200, total_tokens=300, cost_cents=5)
    out1 = svc.record_usage(ctx, body)
    assert out1["cost_cents"] == 5
    got = svc.get_usage(ctx, run_id="r-1", source_type="run_summary")
    assert got is not None and got["input_tokens"] == 100
    # upsert overwrites
    body2 = UsageLedgerIn(run_id="r-1", employee_id="emp-1",
                          input_tokens=9, output_tokens=9, total_tokens=18, cost_cents=1)
    svc.record_usage(ctx, body2)
    assert svc.get_usage(ctx, run_id="r-1", source_type="run_summary")["cost_cents"] == 1


def test_record_usage_create_mode():
    svc = UsageAuditQuotaService(_FakeUsageRepo())
    ctx = _uctx()
    body = UsageLedgerIn(run_id="r-1", employee_id="emp-1", cost_cents=7)
    out = svc.record_usage(ctx, body, mode="create")
    assert out["cost_cents"] == 7


def test_list_usage_with_employee_filter():
    svc = UsageAuditQuotaService(_FakeUsageRepo())
    ctx = _uctx()
    svc.record_usage(ctx, UsageLedgerIn(run_id="r-1", employee_id="emp-1", cost_cents=1))
    svc.record_usage(ctx, UsageLedgerIn(run_id="r-2", employee_id="emp-2", cost_cents=2))
    items = svc.list_usage_ledger(ctx, employee_id="emp-1")
    assert len(items) == 1 and items[0]["employee_id"] == "emp-1"
