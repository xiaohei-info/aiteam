from __future__ import annotations

from datetime import datetime, timedelta, timezone
import pytest

from manager_service import hindsight_lease_repository as repository_module
from manager_service.hindsight_credentials import HindsightLeaseForbidden
from manager_service.hindsight_lease_repository import HindsightLeaseRepository, policy_fingerprint, token_sha256
from tests.manager._fake_router import FakeCursor, FakeRouter


TENANT = "11111111-1111-1111-1111-111111111111"
MEMBER = "22222222-2222-2222-2222-222222222222"
EMPLOYEE = "33333333-3333-3333-3333-333333333333"
BANK = "aiteam-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
ISSUED = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _row(*, token: str = "lease-secret", revoked_at=None, expires_at=None):
    return (
        "lease-1",
        token_sha256(token),
        TENANT,
        MEMBER,
        EMPLOYEE,
        "snap-1",
        policy_fingerprint("snap-1", {"enabled": True}),
        BANK,
        1,
        ISSUED,
        expires_at or ISSUED + timedelta(minutes=5),
        revoked_at,
    )


class _AdminConnection:
    def __init__(self, row):
        self.row = row
        self.executed: list[tuple[str, tuple | None]] = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=None):
        self.executed.append((str(sql), params))
        return FakeCursor(fetchone=self.row, rowcount=0)


def _store(monkeypatch, router: FakeRouter, *, now=lambda: ISSUED):
    monkeypatch.setattr(repository_module, "PgTenantRouter", lambda _dsn: router)
    return HindsightLeaseRepository(
        "postgresql://app_rw/db",
        "postgresql://admin/db",
        now=now,
        token_factory=lambda: "lease-secret",
        lease_id_factory=lambda: "lease-1",
    )


def test_issue_uses_app_rw_scope_and_only_persists_token_hash(monkeypatch):
    router = FakeRouter()
    router.queue_many(FakeCursor(), FakeCursor(fetchone=None), FakeCursor(fetchone=_row()))
    store = _store(monkeypatch, router)

    lease = store.issue(
        tenant_id=TENANT,
        member_id=MEMBER,
        employee_id=EMPLOYEE,
        snapshot_version="snap-1",
        policy={"enabled": True},
        bank_id=BANK,
    )

    assert lease.token == "lease-secret"
    insert_sql, insert_params = router.executed[-1]
    assert "INSERT INTO hindsight_lease" in insert_sql
    assert "lease-secret" not in str(insert_params)
    assert token_sha256("lease-secret") in insert_params
    assert "app.tenant_id" in router.executed[0][0] or "pg_advisory" in router.executed[0][0]


def test_restart_resolves_existing_hash_and_checks_bank_scope(monkeypatch):
    router = FakeRouter()
    restarted = _store(monkeypatch, router)
    conn = _AdminConnection(_row())
    monkeypatch.setattr("psycopg.connect", lambda *args, **kwargs: conn)

    lease = restarted.resolve("lease-secret", bank_id=BANK)
    assert lease.lease_id == "lease-1"
    assert lease.tenant_id == TENANT
    assert lease.token == ""  # raw token is not reconstructed after restart
    with pytest.raises(HindsightLeaseForbidden):
        restarted.resolve("lease-secret", bank_id="aiteam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    assert all("lease-secret" not in str(item) for item in conn.executed)


def test_restart_rejects_expired_and_revoked_rows(monkeypatch):
    for row in (
        _row(expires_at=ISSUED - timedelta(seconds=1)),
        _row(revoked_at=ISSUED - timedelta(seconds=1)),
    ):
        store = _store(monkeypatch, FakeRouter())
        conn = _AdminConnection(row)
        monkeypatch.setattr("psycopg.connect", lambda *args, **kwargs: conn)
        with pytest.raises(Exception, match="expired or revoked"):
            store.resolve("lease-secret", bank_id=BANK)


def test_same_scope_reuses_cached_token_without_rotation(monkeypatch):
    router = FakeRouter()
    router.queue_many(FakeCursor(), FakeCursor(fetchone=None), FakeCursor(fetchone=_row()))
    store = _store(monkeypatch, router)
    first = store.issue(
        tenant_id=TENANT,
        member_id=MEMBER,
        employee_id=EMPLOYEE,
        snapshot_version="snap-1",
        policy={"enabled": True},
        bank_id=BANK,
    )

    router.queue_many(FakeCursor(), FakeCursor(fetchone=_row()))
    reused = store.issue(
        tenant_id=TENANT,
        member_id=MEMBER,
        employee_id=EMPLOYEE,
        snapshot_version="snap-1",
        policy={"enabled": True},
        bank_id=BANK,
    )
    assert reused.lease_id == first.lease_id
    assert reused.token == first.token
    assert not any("INSERT INTO hindsight_lease" in sql for sql, _ in router.executed[3:])
