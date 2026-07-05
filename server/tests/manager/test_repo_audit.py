"""audit_repository.py branch coverage."""
from __future__ import annotations

from datetime import datetime

from manager_service.audit_repository import AuditRepository
from ._fake_router import FakeCursor, FakeRouter, ctx


def test_list_events():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[("e-1", "login", "u-1", None, None, {}, datetime.utcnow())]))
    rows = AuditRepository(router).list_events(ctx())
    assert len(rows) == 1


def test_list_events_filtered():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[("e-1", "login", "u-1", None, None, {}, datetime.utcnow())]))
    rows = AuditRepository(router).list_events(ctx(), event_type="login", target_type="user")
    assert len(rows) == 1


def test_list_events_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    assert AuditRepository(router).list_events(ctx()) == []


def test_create_event():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=("e-1", "login", "u-1", None, None, {}, datetime.utcnow())))
    row = AuditRepository(router).create_event(ctx(), event_type="login", actor_id="u-1")
    assert row.event_type == "login"
