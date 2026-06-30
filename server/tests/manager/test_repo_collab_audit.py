"""collab_audit_repository.py branch coverage (issue #265)."""
from __future__ import annotations

from datetime import datetime

from manager_service.collab_audit_repository import CollabAuditRepository
from ._fake_router import FakeCursor, FakeRouter, ctx


def _tmpl_row(tid="t-1", config=None):
    return (tid, "默认协作模板", config or {}, datetime.utcnow())


def test_get_template_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_tmpl_row()))
    row = CollabAuditRepository(router).get_template(ctx())
    assert row is not None

def test_get_template_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert CollabAuditRepository(router).get_template(ctx()) is None

def test_upsert_template_insert():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))  # existing
    router.queue(FakeCursor(rowcount=1))  # INSERT
    router.queue(FakeCursor(fetchone=_tmpl_row()))  # fetch after
    row = CollabAuditRepository(router).upsert_template(ctx(), name="New")
    assert row.name == "默认协作模板"

def test_upsert_template_update():
    import json
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_tmpl_row()))  # existing
    router.queue(FakeCursor(rowcount=1))  # UPDATE
    # fetch after: config includes max_replies_per_message=5
    router.queue(FakeCursor(fetchone=_tmpl_row(config={"max_replies_per_message": 5})))
    row = CollabAuditRepository(router).upsert_template(ctx(), max_replies_per_message=5)
    assert row.max_replies_per_message == 5

def test_list_events():
    from datetime import datetime
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[("e-1", "login", "u-1", None, None, {}, datetime.utcnow())]))
    rows = CollabAuditRepository(router).list_events(ctx())
    assert len(rows) == 1

def test_list_events_filtered():
    from datetime import datetime
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[("e-1", "login", "u-1", None, None, {}, datetime.utcnow())]))
    rows = CollabAuditRepository(router).list_events(ctx(), event_type="login", target_type="user")
    assert len(rows) == 1

def test_list_events_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    assert CollabAuditRepository(router).list_events(ctx()) == []

def test_create_event():
    from datetime import datetime
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=("e-1", "login", "u-1", None, None, {}, datetime.utcnow())))
    row = CollabAuditRepository(router).create_event(ctx(), event_type="login", actor_id="u-1")
    assert row.event_type == "login"

def test_list_events_by_target_id():
    from datetime import datetime
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[("e-1", "login", None, "user", "u-1", {}, datetime.utcnow())]))
    rows = CollabAuditRepository(router).list_events(ctx(), target_id="u-1")
    assert len(rows) == 1
    sql = router.last_sql
    assert "target_id = %s::uuid" in sql
    assert "target_type =" not in sql


def test_list_events_combined_target_filters():
    from datetime import datetime
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[("e-1", "login", None, "user", "u-1", {}, datetime.utcnow())]))
    rows = CollabAuditRepository(router).list_events(ctx(), target_type="user", target_id="u-1")
    assert len(rows) == 1
    sql = router.last_sql
    assert "target_type = %s" in sql
    assert "target_id = %s::uuid" in sql
