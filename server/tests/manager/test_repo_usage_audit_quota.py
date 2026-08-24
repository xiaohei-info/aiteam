"""usage_audit_quota_repository.py branch coverage (issue #234, target >=90%)."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from manager_service.usage_audit_quota_repository import (
    AuditSummaryRow,
    QuotaPolicyRow,
    UsageAuditQuotaRepository,
    UsageRollupRow,
    _row_to_audit,
    _row_to_quota,
    _row_to_usage,
    _to_uuid,
)

from ._fake_router import FakeCursor, FakeRouter, ctx


def _usage_row(rid="11111111-1111-1111-1111-111111111111", tid="22222222-2222-2222-2222-222222222222", sid="s1", emp=None, ws=None, we=None,
               rc=5, tt=1000, cost=Decimal("1.5"), pv=1, ps="known", currency="USD", ec=1, dur=600, recv=None):
    return (rid, tid, sid, emp, ws or datetime(2026, 1, 10), we or datetime(2026, 1, 11),
            rc, tt, cost, pv, ps, currency, ec, dur, recv or datetime(2026, 1, 12))


def _audit_row(eid="11111111-1111-1111-1111-111111111111", tid="22222222-2222-2222-2222-222222222222", sid="a1", actor="m", action="act",
               rtype="expert", rid2="e1", occ=None, recv=None):
    return (eid, tid, sid, actor, action, rtype, rid2,
            occ or datetime(2026, 1, 10), recv or datetime(2026, 1, 12))


def _quota_row(qid="11111111-1111-1111-1111-111111111111", tid="22222222-2222-2222-2222-222222222222", slug="default", name="Default", scope="tenant",
               tref=None, ws=None, we=None, dims=None, enf="soft", status="active",
               ver=1, ca=None, ua=None):
    return (qid, tid, slug, name, scope, tref,
            ws or datetime(2026, 1, 1), we or datetime(2026, 2, 1),
            dims or {"cost_cap_usd": 100}, enf, status, ver,
            ca or datetime(2026, 1, 1), ua or datetime(2026, 1, 2))


def test_upsert_usage_returns_row():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_usage_row(emp="33333333-3333-3333-3333-333333333333")))
    repo = UsageAuditQuotaRepository(router)
    payload = {
        "summary_id": "s1", "employee_id": "33333333-3333-3333-3333-333333333333",
        "window_start": datetime(2026, 1, 10), "window_end": datetime(2026, 1, 11),
        "run_count": 5, "token_total": 1000, "cost_total": Decimal("1.5"),
        "error_count": 1, "duration_seconds_total": 600,
    }
    row = repo.upsert_usage(ctx(), payload=payload)
    assert isinstance(row, UsageRollupRow)
    assert row.employee_id == "33333333-3333-3333-3333-333333333333"
    assert row.cost_total == Decimal("1.5")


def test_list_usage_returns_rows():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_usage_row("u1"), _usage_row("u2", sid="s2")]))
    rows = UsageAuditQuotaRepository(router).list_usage(ctx())
    assert len(rows) == 2

def test_list_usage_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    assert UsageAuditQuotaRepository(router).list_usage(ctx()) == []


def test_aggregate_usage_returns_dict():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=(2, 8, 2000, Decimal("3.0"), 0, 1200)))
    agg = UsageAuditQuotaRepository(router).aggregate_usage(
        ctx(), window_start=datetime(2026, 1, 1), window_end=datetime(2026, 2, 1)
    )
    assert agg == {"rollup_count": 2, "run_count": 8, "token_total": 2000,
                   "cost_total": Decimal("3.0"), "error_count": 0, "duration_seconds_total": 1200}


def test_upsert_audit_returns_row():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_audit_row(rtype=None, rid2=None)))
    repo = UsageAuditQuotaRepository(router)
    payload = {"summary_id": "s1", "actor": "m", "action": "act",
               "resource_type": None, "resource_id": None, "occurred_at": datetime(2026, 1, 10)}
    row = repo.upsert_audit(ctx(), payload=payload)
    assert isinstance(row, AuditSummaryRow)
    assert row.resource_type is None
    assert row.resource_id is None


def test_list_audits_returns_rows():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_audit_row("a1"), _audit_row("a2", sid="s2")]))
    rows = UsageAuditQuotaRepository(router).list_audits(ctx())
    assert len(rows) == 2

def test_list_audits_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    assert UsageAuditQuotaRepository(router).list_audits(ctx()) == []


def test_create_quota_returns_row():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_quota_row()))
    row = UsageAuditQuotaRepository(router).create_quota(
        ctx(), policy_slug="default", display_name="Default", scope="tenant",
        target_ref=None, window_start=datetime(2026, 1, 1), window_end=datetime(2026, 2, 1),
        dimensions={"cost_cap_usd": 100}, enforcement="soft", status="active",
    )
    assert isinstance(row, QuotaPolicyRow)
    assert row.dimensions == {"cost_cap_usd": 100}


def test_get_quota_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_quota_row()))
    assert UsageAuditQuotaRepository(router).get_quota(ctx(), policy_id="11111111-1111-1111-1111-111111111111") is not None

def test_get_quota_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert UsageAuditQuotaRepository(router).get_quota(ctx(), policy_id="99999999-9999-9999-9999-999999999999") is None


def test_get_quota_by_slug_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_quota_row(slug="default")))
    row = UsageAuditQuotaRepository(router).get_quota_by_slug(ctx(), policy_slug="default")
    assert row is not None
    assert row.policy_slug == "default"

def test_get_quota_by_slug_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert UsageAuditQuotaRepository(router).get_quota_by_slug(ctx(), policy_slug="x") is None


def test_update_quota_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_quota_row(name="Updated", enf="hard", ver=2)))
    row = UsageAuditQuotaRepository(router).update_quota(
        ctx(), policy_id="11111111-1111-1111-1111-111111111111", display_name="Updated", scope="tenant",
        target_ref=None, window_start=datetime(2026, 1, 1), window_end=datetime(2026, 2, 1),
        dimensions={"cost_cap_usd": 200}, enforcement="hard", status="active",
    )
    assert row is not None
    assert row.display_name == "Updated"
    assert row.enforcement == "hard"

def test_update_quota_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    row = UsageAuditQuotaRepository(router).update_quota(
        ctx(), policy_id="99999999-9999-9999-9999-999999999999", display_name="X", scope="tenant",
        target_ref=None, window_start=datetime(2026, 1, 1), window_end=datetime(2026, 2, 1),
        dimensions={}, enforcement="soft", status="active",
    )
    assert row is None


def test_delete_quota_returns_true():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=("11111111-1111-1111-1111-111111111111",)))
    assert UsageAuditQuotaRepository(router).delete_quota(ctx(), policy_id="11111111-1111-1111-1111-111111111111") is True

def test_delete_quota_returns_false():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert UsageAuditQuotaRepository(router).delete_quota(ctx(), policy_id="99999999-9999-9999-9999-999999999999") is False


def test_list_quotas_returns_rows():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_quota_row("q1"), _quota_row("q2", slug="p2")]))
    rows = UsageAuditQuotaRepository(router).list_quotas(ctx())
    assert len(rows) == 2

def test_list_quotas_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    assert UsageAuditQuotaRepository(router).list_quotas(ctx()) == []


# ---- _to_uuid helper ----

def test_to_uuid_none():
    assert _to_uuid(None) is None

def test_to_uuid_uuid_object():
    u = uuid4()
    assert _to_uuid(u) == u

def test_to_uuid_str():
    u = uuid4()
    assert _to_uuid(str(u)) == u


# ---- _row_to_* with edge cases ----

def test_row_to_usage_null_employee():
    row = _row_to_usage(_usage_row(emp=None))
    assert row.employee_id is None

def test_row_to_audit_null_resource():
    row = _row_to_audit(_audit_row(rtype=None, rid2=None))
    assert row.resource_type is None
    assert row.resource_id is None

def test_row_to_quota_empty_dims():
    raw = list(_quota_row())
    raw[8] = None
    row = _row_to_quota(tuple(raw))
    assert row.dimensions == {}
