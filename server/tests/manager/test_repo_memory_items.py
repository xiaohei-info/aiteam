"""memory_items_repository.py branch coverage (issue #265)."""
from __future__ import annotations

from datetime import datetime

from manager_service.memory_items_repository import MemoryItemsRepository
from ._fake_router import FakeCursor, FakeRouter, ctx


def _mem_row(mid="m-1", eid="e-1", content="test", cat="preference", imp=3, src="manual"):
    return (mid, eid, content, cat, imp, src, datetime.utcnow(), None)


def test_list_all():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_mem_row()]))
    rows = MemoryItemsRepository(router).list(ctx())
    assert len(rows) == 1

def test_list_filtered():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_mem_row()]))
    rows = MemoryItemsRepository(router).list(ctx(), employee_id="e-1", keyword="test", category="preference")
    assert len(rows) == 1

def test_list_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    assert MemoryItemsRepository(router).list(ctx()) == []

def test_get_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_mem_row()))
    assert MemoryItemsRepository(router).get(ctx(), "m-1") is not None

def test_get_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert MemoryItemsRepository(router).get(ctx(), "x") is None

def test_create():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_mem_row()))
    row = MemoryItemsRepository(router).create(ctx(), employee_id="e-1", content="test", category="preference", importance=3)
    assert row.content == "test"

def test_update():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_mem_row(content="updated")))
    row = MemoryItemsRepository(router).update(ctx(), "m-1", content="updated")
    assert row is not None
    assert row.content == "updated"

def test_update_no_fields():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_mem_row()))
    row = MemoryItemsRepository(router).update(ctx(), "m-1")
    assert row is not None

def test_update_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert MemoryItemsRepository(router).update(ctx(), "x", content="x") is None

def test_delete():
    router = FakeRouter()
    router.queue(FakeCursor(rowcount=1))
    assert MemoryItemsRepository(router).delete(ctx(), "m-1") is True

def test_bulk_delete():
    router = FakeRouter()
    router.queue(FakeCursor(rowcount=2))
    count = MemoryItemsRepository(router).bulk_delete(ctx(), ["m-1", "m-2"])
    assert count == 2

def test_bulk_delete_empty():
    router = FakeRouter()
    assert MemoryItemsRepository(router).bulk_delete(ctx(), []) == 0
