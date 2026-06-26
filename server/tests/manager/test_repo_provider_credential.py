"""provider_credential_repository.py branch coverage (issue #234, target >=90%)."""

from __future__ import annotations

from manager_service.provider_credential_repository import (
    ProviderCredentialRepository,
    ProviderCredentialRow,
    _row_to_credential,
)

from ._fake_router import FakeCursor, FakeRouter, ctx


def _cred_row(cid="c-1", ref="relay-default", name="Default", mode="relay",
              endpoint="https://relay.local", secret=b"encrypted", vis="tenant", mems=None, ver=1):
    return (cid, ref, name, mode, endpoint, secret, vis, mems or ["m-1"], ver)


def test_create_returns_row():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_cred_row()))
    row = ProviderCredentialRepository(router).create(
        ctx(), provider_ref="relay-default", display_name="Default", mode="relay",
        endpoint="https://relay.local", encrypted_secret=b"encrypted", visibility="tenant",
        allowed_member_ids=["m-1"],
    )
    assert isinstance(row, ProviderCredentialRow)
    assert row.credential_id == "c-1"
    assert row.provider_ref == "relay-default"
    assert row.version == 1


def test_get_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_cred_row()))
    row = ProviderCredentialRepository(router).get(ctx(), credential_id="c-1")
    assert row is not None
    assert row.visibility == "tenant"

def test_get_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert ProviderCredentialRepository(router).get(ctx(), credential_id="x") is None


def test_get_by_ref_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_cred_row(ref="shared")))
    row = ProviderCredentialRepository(router).get_by_ref(ctx(), provider_ref="shared")
    assert row is not None
    assert row.provider_ref == "shared"

def test_get_by_ref_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert ProviderCredentialRepository(router).get_by_ref(ctx(), provider_ref="x") is None


def test_update_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_cred_row(name="Updated", ver=2)))
    row = ProviderCredentialRepository(router).update(
        ctx(), credential_id="c-1", display_name="Updated", mode="direct",
        endpoint="https://api.local", encrypted_secret=b"new", visibility="members",
        allowed_member_ids=["m-2"],
    )
    assert row is not None
    assert row.display_name == "Updated"
    assert row.version == 2

def test_update_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    row = ProviderCredentialRepository(router).update(
        ctx(), credential_id="x", display_name="X", mode="relay",
        endpoint=None, encrypted_secret=b"x", visibility="tenant", allowed_member_ids=[],
    )
    assert row is None


def test_delete_returns_true():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=("c-1",)))
    assert ProviderCredentialRepository(router).delete(ctx(), credential_id="c-1") is True

def test_delete_returns_false():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert ProviderCredentialRepository(router).delete(ctx(), credential_id="x") is False


def test_list_all_returns_rows():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_cred_row("c1"), _cred_row("c2", ref="relay2")]))
    rows = ProviderCredentialRepository(router).list_all(ctx())
    assert len(rows) == 2

def test_list_all_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    assert ProviderCredentialRepository(router).list_all(ctx()) == []


# ---- _row_to_credential edge cases ----

def test_row_to_credential_null_secret():
    raw = list(_cred_row())
    raw[5] = None
    row = _row_to_credential(tuple(raw))
    assert row.encrypted_secret == b""

def test_row_to_credential_null_member_ids():
    raw = list(_cred_row())
    raw[7] = None
    row = _row_to_credential(tuple(raw))
    assert row.allowed_member_ids == []

def test_row_to_credential_empty_endpoint():
    row = _row_to_credential(_cred_row(endpoint=None))
    assert row.endpoint is None
