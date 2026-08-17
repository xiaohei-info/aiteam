"""settings_repository.py branch coverage (issue #265)."""
from __future__ import annotations

from datetime import datetime

from manager_service.settings_repository import SettingsRepository
from ._fake_router import FakeCursor, FakeRouter, ctx


def _set_row(
    eid="s-1", name="Test", email="contact@test.com", phone="", logo=None,
    inv=True, appr=True, mx=100, feat=None,
):
    return (
        eid, name, email, phone, logo, inv, appr, mx,
        feat or {}, datetime.utcnow(),
    )


def test_get_settings_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_set_row()))
    row = SettingsRepository(router).get_settings(ctx())
    assert row is not None
    assert row.enterprise_name == "Test"
    assert row.contact_email == "contact@test.com"
    assert row.invite_required is True
    assert row.member_approval is True
    assert row.max_employees == 100
    assert row.features == {}


def test_get_settings_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert SettingsRepository(router).get_settings(ctx()) is None


def test_upsert_settings_insert():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))  # existing check
    router.queue(FakeCursor(rowcount=1))  # INSERT
    router.queue(FakeCursor(fetchone=_set_row(name="New", email="new@test.com", mx=50)))
    row = SettingsRepository(router).upsert_settings(
        ctx(), enterprise_name="New", contact_email="new@test.com", max_employees=50,
    )
    assert row.enterprise_name == "New"
    assert row.contact_email == "new@test.com"
    assert row.max_employees == 50


def test_upsert_settings_update_all_fields():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_set_row(name="Old")))  # existing check
    router.queue(FakeCursor(rowcount=1))  # UPDATE
    router.queue(FakeCursor(fetchone=_set_row(
        name="Updated", email="u@test.com", phone="13800138000",
        logo="https://x/logo.png", inv=False,
        appr=False, mx=200, feat={"sso": True},
    )))  # fetch after
    row = SettingsRepository(router).upsert_settings(
        ctx(),
        enterprise_name="Updated",
        contact_email="u@test.com",
        contact_phone="13800138000",
        logo_url="https://x/logo.png",
        invite_required=False,
        member_approval=False,
        max_employees=200,
        features={"sso": True},
    )
    assert row.enterprise_name == "Updated"
    assert row.contact_email == "u@test.com"
    assert row.contact_phone == "13800138000"
    assert row.logo_url == "https://x/logo.png"
    assert row.invite_required is False
    assert row.member_approval is False
    assert row.max_employees == 200
    assert row.features == {"sso": True}


def test_upsert_settings_update_partial():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_set_row(name="Old", email="old@test.com")))  # existing check
    router.queue(FakeCursor(rowcount=1))  # UPDATE
    router.queue(FakeCursor(fetchone=_set_row(name="Old", email="new@test.com")))  # fetch after
    row = SettingsRepository(router).upsert_settings(ctx(), contact_email="new@test.com")
    assert row.contact_email == "new@test.com"


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
