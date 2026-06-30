"""connector_ops_repository.py branch coverage (issue #265)."""
from __future__ import annotations

from datetime import datetime

from manager_service.connector_ops_repository import ConnectorOpsRepository
from ._fake_router import FakeCursor, FakeRouter, ctx


def test_get_status_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=("slack", "connected", datetime.utcnow(), None)))
    row = ConnectorOpsRepository(router).get_status(ctx(), "slack")
    assert row is not None
    assert row.status == "connected"

def test_get_status_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert ConnectorOpsRepository(router).get_status(ctx(), "x") is None

def test_upsert_status():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=("slack", "connected", datetime.utcnow(), None)))
    row = ConnectorOpsRepository(router).upsert_status(ctx(), "slack", status="connected")
    assert row.connector_id == "slack"

def test_create_test():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=("slack", True, 42, "ok", datetime.utcnow())))
    row = ConnectorOpsRepository(router).create_test(ctx(), "slack", success=True, latency_ms=42, message="ok")
    assert row.success is True

def test_list_tests():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[("slack", True, 10, "ok", datetime.utcnow())]))
    rows = ConnectorOpsRepository(router).list_tests(ctx(), "slack")
    assert len(rows) == 1

def test_get_grants_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=("slack", ["e-1"], datetime.utcnow())))
    row = ConnectorOpsRepository(router).get_grants(ctx(), "slack")
    assert row is not None
    assert "e-1" in row.employee_ids

def test_get_grants_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert ConnectorOpsRepository(router).get_grants(ctx(), "x") is None

def test_set_grants():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=("slack", ["e-1", "e-2"], datetime.utcnow())))
    row = ConnectorOpsRepository(router).set_grants(ctx(), "slack", ["e-1", "e-2"])
    assert len(row.employee_ids) == 2
