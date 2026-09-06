"""passkey_store unit tests (non-integration; FakeRouter). tenant_id carried only via TenantContext (D22)."""

from __future__ import annotations

import pytest

from manager_service.passkey_store import PasskeyStore

from ._fake_router import FakeCursor, FakeRouter, ctx


def _cred_row(uid="u-1", cid="cred-1", label="My Passkey", sign_count=0):
    # columns: id, tenant_id, user_id, credential_id, public_key_pem, sign_count, label, created_at, last_used_at
    return (cid + "-id", "t", uid, cid, "PUBLICKEYPEM", sign_count, label, None, None)


def test_list_for_user_maps_rows():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_cred_row(), _cred_row(cid="cred-2", uid="u-2")]))
    store = PasskeyStore(router)
    rows = store.list_for_user(ctx(), "u-1")
    sql, _ = router.executed[0]
    assert "passkey_credential" in sql
    assert len(rows) == 2
    assert rows[0].credential_id == "cred-1"
    assert rows[0].tenant_id == "t"


def test_insert_persists_and_returns_id():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=("new-id",)))
    store = PasskeyStore(router)
    rid = store.insert(ctx(), user_id="u-1", credential_id="cred-x",
                      public_key_pem="PEM", sign_count=0, label="lbl")
    assert rid == "new-id"
    sql, params = router.executed[0]
    assert "INSERT INTO passkey_credential" in sql
    # (tenant_id, user_id, credential_id, public_key_pem, sign_count, label)
    assert params[1] == "u-1"
    assert params[2] == "cred-x"
    assert params[3] == "PEM"


def test_update_usage_then_delete():
    router = FakeRouter()
    router.queue_many(FakeCursor(rowcount=1), FakeCursor(), FakeCursor(fetchone=(1,)), FakeCursor(fetchone=(1,)), FakeCursor(rowcount=1))
    store = PasskeyStore(router)
    store.update_usage(ctx(), credential_id="cred-1", sign_count=7)
    assert "UPDATE passkey_credential" in router.executed[0][0]
    deleted = store.delete(ctx(), credential_id="cred-1")
    assert deleted is True
    assert router.executed[-1][0].startswith("DELETE")


def test_find_by_credential_none_when_missing():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    store = PasskeyStore(router)
    assert store.find_by_credential(ctx(), "nope") is None


def test_delete_returns_false_when_missing():
    router = FakeRouter()
    router.queue(FakeCursor(rowcount=0))
    store = PasskeyStore(router)
    assert store.delete(ctx(), credential_id="nope") is False
