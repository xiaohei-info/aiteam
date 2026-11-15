from __future__ import annotations

import json
from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from cryptography.fernet import Fernet

from operation_service.onboarding_receipt import (
    InMemoryOnboardingReceiptStore,
    PgOnboardingReceiptStore,
    build_onboarding_receipt_store,
    canonical_request_fingerprint,
    normalize_idempotency_key,
)
from shared.errors import Conflict, ServiceUnavailable, ValidationProblem


def values(key="onboard-1", fingerprint="fp"):
    return dict(
        idempotency_key=key,
        request_fingerprint=fingerprint,
        request_body={"enterprise_name": "Acme", "optional": None},
        enterprise_id="11111111-1111-4111-8111-111111111111",
        tenant_id="22222222-2222-4222-8222-222222222222",
        enterprise_name="Acme",
        enterprise_code="acme",
        owner_phone="13800000000",
        bootstrap_secret="bootstrap-secret",
    )


def test_in_memory_receipt_reservation_is_idempotent_and_encrypted(monkeypatch):
    monkeypatch.delenv("OPERATION_ONBOARDING_RECEIPT_KEY", raising=False)
    monkeypatch.delenv("OPERATION_PROVIDER_CREDENTIAL_KEY", raising=False)
    store = InMemoryOnboardingReceiptStore()
    first = store.reserve(**values())
    assert first.state == "prepared"
    assert first.bootstrap_secret == "bootstrap-secret"
    assert first.bootstrap_secret_ciphertext != "bootstrap-secret"
    assert "bootstrap-secret" not in repr(store._rows["onboard-1"])
    assert store.reserve(**values()).tenant_id == first.tenant_id
    with pytest.raises(Conflict):
        store.reserve(**values(fingerprint="different"))
    store.complete("onboard-1", {"enterprise_id": first.enterprise_id})
    assert store._rows["onboard-1"].state == "completed"
    assert store._rows["onboard-1"].safe_response == {"enterprise_id": first.enterprise_id}
    with pytest.raises(ServiceUnavailable):
        store.complete("missing", {})


def test_receipt_helpers_validate_keys_and_canonicalize_body():
    assert normalize_idempotency_key(" key ") == "key"
    with pytest.raises(ValidationProblem):
        normalize_idempotency_key(None)
    with pytest.raises(ValidationProblem):
        normalize_idempotency_key("bad\nkey")
    with pytest.raises(ValidationProblem):
        normalize_idempotency_key("x" * 257)
    assert canonical_request_fingerprint({"b": 1, "a": None}) == canonical_request_fingerprint({"a": None, "b": 1})


def test_invalid_receipt_cipher_fails_closed(monkeypatch):
    monkeypatch.setenv("OPERATION_ONBOARDING_RECEIPT_KEY", "invalid")
    with pytest.raises(ServiceUnavailable):
        InMemoryOnboardingReceiptStore()
    monkeypatch.delenv("OPERATION_ONBOARDING_RECEIPT_KEY", raising=False)
    monkeypatch.delenv("OPERATION_PROVIDER_CREDENTIAL_KEY", raising=False)
    with pytest.raises(ServiceUnavailable):
        PgOnboardingReceiptStore("postgresql://admin")
    store = InMemoryOnboardingReceiptStore()
    with pytest.raises(ServiceUnavailable):
        store._cipher.decrypt("invalid-ciphertext")


class Cursor:
    def __init__(self, row=None, rowcount=1):
        self.row = row
        self.rowcount = rowcount

    def fetchone(self):
        return self.row


class Connection:
    def __init__(self, *cursors):
        self.cursors = list(cursors)
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        return self.cursors.pop(0)


def _pg_row(store, *, fingerprint="fp", response=None):
    payload = response
    return (
        "onboard-1", fingerprint, "prepared", {"enterprise_name": "Acme"},
        "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
        "Acme", "acme", "13800000000", store._cipher.encrypt("bootstrap-secret"),
        datetime.now(UTC), json.dumps(payload) if payload is not None else None,
    )


def test_pg_receipt_reserve_replays_and_rejects_fingerprint(monkeypatch):
    monkeypatch.setenv("OPERATION_ONBOARDING_RECEIPT_KEY", Fernet.generate_key().decode())
    store = PgOnboardingReceiptStore("postgresql://admin")
    first_connection = Connection(Cursor(_pg_row(store)))
    with patch("psycopg.connect", return_value=first_connection):
        first = store.reserve(**values())
    assert first.bootstrap_secret == "bootstrap-secret"
    assert "ON CONFLICT" in first_connection.calls[0][0]

    replay_connection = Connection(Cursor(None), Cursor(_pg_row(store, response={"tenant_id": "t"})))
    with patch("psycopg.connect", return_value=replay_connection):
        replay = store.reserve(**values())
    assert replay.safe_response == {"tenant_id": "t"}
    conflict_connection = Connection(Cursor(None), Cursor(_pg_row(store, fingerprint="other")))
    with patch("psycopg.connect", return_value=conflict_connection), pytest.raises(Conflict):
        store.reserve(**values())


def test_pg_receipt_maps_missing_rows_and_database_failures(monkeypatch):
    monkeypatch.setenv("OPERATION_ONBOARDING_RECEIPT_KEY", Fernet.generate_key().decode())
    store = PgOnboardingReceiptStore("postgresql://admin")
    with patch("psycopg.connect", return_value=Connection(Cursor(None), Cursor(None))), pytest.raises(ServiceUnavailable):
        store.reserve(**values())
    with patch("psycopg.connect", side_effect=OSError("database down")), pytest.raises(ServiceUnavailable):
        store.reserve(**values())

    missing_update = Connection(Cursor(rowcount=0, row=None))
    with patch("psycopg.connect", return_value=missing_update), pytest.raises(ServiceUnavailable):
        store.complete("missing", {})
    updated = Connection(Cursor(rowcount=1, row=None))
    with patch("psycopg.connect", return_value=updated):
        store.complete("onboard-1", {"tenant_id": "t"})
    assert "response_body" in updated.calls[0][0]
    with patch("psycopg.connect", side_effect=OSError("database down")), pytest.raises(ServiceUnavailable):
        store.complete("onboard-1", {})


def test_build_receipt_store_caches_per_repository():
    class Repo:
        pass

    repository = Repo()
    first = build_onboarding_receipt_store(repository)
    second = build_onboarding_receipt_store(repository)
    assert first is second


def test_pg_receipt_expires_secrets_singly_and_in_bulk(monkeypatch):
    from datetime import timedelta

    monkeypatch.setenv("OPERATION_ONBOARDING_RECEIPT_KEY", Fernet.generate_key().decode())
    store = PgOnboardingReceiptStore("postgresql://admin")

    single = Connection(Cursor(rowcount=1))
    with patch("psycopg.connect", return_value=single):
        store.expire_secret("onboard-1")
    sql, params = single.calls[0]
    assert "bootstrap_secret_ciphertext=NULL" in sql and "state='completed'" in sql and params == ("onboard-1",)

    cutoff = datetime.now(UTC) - timedelta(hours=24)
    bulk = Connection(Cursor(rowcount=3))
    with patch("psycopg.connect", return_value=bulk):
        assert store.expire_secrets_before(cutoff) == 3
    sql, params = bulk.calls[0]
    # 只清已完成且仍有密文的回执；prepared 回执续跑要用，不能动。
    assert "state='completed'" in sql and "IS NOT NULL" in sql and "completed_at <" in sql and params == (cutoff,)

    with patch("psycopg.connect", side_effect=OSError("database down")):
        with pytest.raises(ServiceUnavailable):
            store.expire_secret("onboard-1")
        with pytest.raises(ServiceUnavailable):
            store.expire_secrets_before(cutoff)


def test_receipt_secret_expiry_rules():
    from datetime import timedelta

    from operation_service.onboarding_receipt import SECRET_RETENTION, BootstrapReceiptExpired

    store = InMemoryOnboardingReceiptStore()
    receipt = store.reserve(**values())
    now = datetime.now(UTC)
    assert receipt.secret_expired(now + SECRET_RETENTION * 5) is False  # prepared 永不过期
    store.complete(receipt.idempotency_key, {"tenant_id": "t"})
    done = store._rows[receipt.idempotency_key]
    completed = done.completed_at
    assert completed is not None
    assert done.secret_expired(completed + SECRET_RETENTION - timedelta(seconds=1)) is False
    assert done.secret_expired(completed + SECRET_RETENTION) is True
    # 历史回执可能没有完成时间或用的是不带时区的时间
    from dataclasses import replace
    assert replace(done, completed_at=None).secret_expired(now + SECRET_RETENTION * 5) is False
    naive = replace(done, completed_at=completed.replace(tzinfo=None))
    assert naive.secret_expired(completed + SECRET_RETENTION) is True
    store.expire_secret(receipt.idempotency_key)
    cleared = store._rows[receipt.idempotency_key]
    assert cleared.secret_expired(now) is True
    with pytest.raises(BootstrapReceiptExpired):
        _ = cleared.bootstrap_secret
