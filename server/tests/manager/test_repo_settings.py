"""settings_repository.py branch coverage (issue #265)."""
from __future__ import annotations

from datetime import datetime

from manager_service.settings_repository import SettingsRepository
from ._fake_router import FakeCursor, FakeRouter, ctx


def _set_row(eid="s-1", name="Test", phone="", logo=None, inv=True, appr=True, mx=100, feat=None):
    return (eid, name, phone, logo, inv, appr, mx, feat or {}, datetime.utcnow())


def test_get_settings_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_set_row()))
    row = SettingsRepository(router).get_settings(ctx())
    assert row is not None
    assert row.enterprise_name == "Test"

def test_get_settings_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert SettingsRepository(router).get_settings(ctx()) is None

def test_upsert_settings_insert():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))  # existing check
    router.queue(FakeCursor(rowcount=1))  # INSERT
    router.queue(FakeCursor(fetchone=_set_row(name="New")))  # fetch after
    row = SettingsRepository(router).upsert_settings(ctx(), enterprise_name="New", logo_url=None)
    assert row.enterprise_name == "New"

def test_upsert_settings_update():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_set_row(name="Old")))  # existing check
    router.queue(FakeCursor(rowcount=1))  # UPDATE
    router.queue(FakeCursor(fetchone=_set_row(name="Updated")))  # fetch after
    row = SettingsRepository(router).upsert_settings(ctx(), enterprise_name="Updated", logo_url=None)
    assert row.enterprise_name == "Updated"

def test_list_invites():
    from datetime import datetime
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[("i-1", "13800138000", "Admin", ["Admin"], "pending", datetime.utcnow())]))
    rows = SettingsRepository(router).list_invites(ctx())
    assert len(rows) == 1

def test_create_invite():
    from datetime import datetime
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=("i-1", "13800138000", "Admin", [], "pending", datetime.utcnow())))
    row = SettingsRepository(router).create_invite(ctx(), phone="13800138000", display_name="Admin", created_by="u-1")
    assert row.phone == "13800138000"

def test_delete_invite():
    router = FakeRouter()
    router.queue(FakeCursor(rowcount=1))
    assert SettingsRepository(router).delete_invite(ctx(), "i-1") is True

def test_delete_invite_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(rowcount=0))
    assert SettingsRepository(router).delete_invite(ctx(), "i-1") is False
