import json
from dataclasses import dataclass

import pytest

from manager_service.idempotency_repository import (
    ManagerIdempotencyRepository,
    request_fingerprint,
)
from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict, ValidationProblem


@dataclass
class _Result:
    row: tuple | None

    def fetchone(self):
        return self.row


class _Session:
    def __init__(self, store):
        self.store = store

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, sql, params=()):
        if sql.startswith("INSERT INTO manager_idempotency_receipt"):
            tenant, operation, key, fingerprint = params
            receipt_key = (tenant, operation, key)
            if receipt_key in self.store:
                return _Result(None)
            self.store[receipt_key] = {
                "fingerprint": fingerprint,
                "state": "pending",
                "response": None,
            }
            return _Result((fingerprint, "pending", None))
        if sql.startswith("SELECT request_fingerprint"):
            tenant, operation, key = params
            receipt = self.store[(tenant, operation, key)]
            return _Result((receipt["fingerprint"], receipt["state"], receipt["response"]))
        if sql.startswith("UPDATE manager_idempotency_receipt"):
            response, _status, tenant, operation, key = params
            receipt = self.store[(tenant, operation, key)]
            receipt["state"] = "completed"
            receipt["response"] = json.loads(response)
            return _Result(None)
        raise AssertionError(sql)


class _Router:
    def __init__(self):
        self.store = {}

    def session(self, _ctx):
        return _Session(self.store)


def test_migrations_define_separate_f01_receipt_and_tenant_scoped_f02_f17_receipts():
    from pathlib import Path

    sql = (Path(__file__).parents[2] / "manager_service/migrations/0042_onboarding_idempotency.sql").read_text(encoding="utf-8")
    assert "CREATE TABLE IF NOT EXISTS manager_idempotency_receipt" in sql
    assert "CREATE TABLE IF NOT EXISTS manager_onboarding_receipt" in sql
    assert "GRANT SELECT, INSERT, UPDATE ON manager_idempotency_receipt TO app_rw" in sql
    assert "GRANT SELECT, INSERT ON manager_onboarding_receipt TO app_rw" not in sql
    assert "response_body" in sql


def test_idempotency_key_rejects_control_characters():
    repository = ManagerIdempotencyRepository(_Router())
    ctx = TenantContext(tenant_id="tenant-a", user_id="service", roles=["service"])
    with pytest.raises(ValidationProblem):
        repository.execute(ctx, operation="f17", idempotency_key="bad\nkey", request_fingerprint="fp", effect=lambda _session: {})


def test_same_tenant_key_and_body_replays_without_running_effect_twice():
    router = _Router()
    repository = ManagerIdempotencyRepository(router)
    ctx = TenantContext(tenant_id="tenant-a", user_id="service", roles=["service"])
    calls = []

    def effect(_session):
        calls.append("notification-row")
        return {"notification_id": "n-1"}

    fingerprint = request_fingerprint("enterprise-notification", {"message": "hello"})
    first = repository.execute(
        ctx,
        operation="enterprise-notification",
        idempotency_key="notify-1",
        request_fingerprint=fingerprint,
        effect=effect,
    )
    replay = repository.execute(
        ctx,
        operation="enterprise-notification",
        idempotency_key="notify-1",
        request_fingerprint=fingerprint,
        effect=effect,
    )

    assert first.replayed is False
    assert replay.replayed is True
    assert replay.payload == first.payload == {"notification_id": "n-1"}
    assert calls == ["notification-row"]


def test_same_key_with_different_body_is_rejected():
    repository = ManagerIdempotencyRepository(_Router())
    ctx = TenantContext(tenant_id="tenant-a", user_id="service", roles=["service"])
    repository.execute(
        ctx,
        operation="owner-bootstrap",
        idempotency_key="bootstrap-1",
        request_fingerprint="fingerprint-a",
        effect=lambda _session: {"tenant_id": "tenant-a", "user_id": "owner-a"},
    )

    with pytest.raises(Conflict):
        repository.execute(
            ctx,
            operation="owner-bootstrap",
            idempotency_key="bootstrap-1",
            request_fingerprint="fingerprint-b",
            effect=lambda _session: {"tenant_id": "tenant-a", "user_id": "owner-b"},
        )
