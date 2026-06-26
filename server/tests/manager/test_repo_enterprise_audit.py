"""enterprise_audit_repository.py branch coverage (issue #234, target >=90%)."""

from __future__ import annotations

from datetime import datetime

from manager_service.enterprise_audit_repository import (
    EnterpriseAuditRepository,
    EnterpriseAuditRow,
    _row_to_audit,
    build_enterprise_audit_repository,
)

from ._fake_router import FakeCursor, FakeRouter, ctx


def _audit_row(aid="a-1", tid="t-1", actor="m-1", action="denied",
               rtype="expert", rid2="e-1", detail="not auth", occ=None):
    return (aid, tid, actor, action, rtype, rid2, detail, occ or datetime(2026, 1, 10))


def test_record_returns_row():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_audit_row()))
    row = EnterpriseAuditRepository(router).record(
        ctx(), actor="m-1", action="denied", resource_type="expert",
        resource_id="e-1", detail="not auth",
    )
    assert isinstance(row, EnterpriseAuditRow)
    assert row.audit_id == "a-1"
    assert row.actor == "m-1"


def test_list_all_returns_rows():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_audit_row("a1"), _audit_row("a2", action="login")]))
    rows = EnterpriseAuditRepository(router).list_all(ctx())
    assert len(rows) == 2

def test_list_all_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    assert EnterpriseAuditRepository(router).list_all(ctx()) == []


def test_row_to_audit_null_fields():
    row = _row_to_audit(_audit_row(rtype=None, rid2=None, detail=None))
    assert row.resource_type is None
    assert row.resource_id is None
    assert row.detail is None


def test_build_enterprise_audit_repository():
    router = FakeRouter()
    repo = build_enterprise_audit_repository(router)
    assert isinstance(repo, EnterpriseAuditRepository)
