"""repository.py (TenantAuthRepository) branch coverage (issue #234, target >=90%)."""

from __future__ import annotations

from manager_service.repository import IdentityRow, TenantAuthRepository
from shared.contracts.enums import AuthProvider

from ._fake_router import FakeCursor, FakeRouter, ctx


def _identity_row(iid="i-1", uid="m-1", secret="secret", must_reset=False, roles=None):
    return (iid, uid, secret, must_reset, 1700000000.0, roles or ["member"])


class TestCreateUserWithIdentity:
    def test_returns_user_id(self):
        router = FakeRouter()
        # First execute = INSERT app_user RETURNING id; second = INSERT auth_identity
        router.queue_many(
            FakeCursor(fetchone=("user-uuid-1",)),
            FakeCursor(),
        )
        uid = TenantAuthRepository(router).create_user_with_identity(
            ctx(), provider=AuthProvider.PASSWORD, external_id="alice",
            secret="pw", roles=["member"], display_name="Alice", must_reset=True,
        )
        assert uid == "user-uuid-1"
        assert len(router.executed) == 2


class TestFindIdentity:
    def test_found(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=_identity_row()))
        row = TenantAuthRepository(router).find_identity(ctx(), provider=AuthProvider.PASSWORD, external_id="alice")
        assert isinstance(row, IdentityRow)
        assert row.identity_id == "i-1"
        assert row.user_id == "m-1"
        assert row.roles == ["member"]
        assert row.must_reset is False

    def test_not_found_returns_none(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=None))
        assert TenantAuthRepository(router).find_identity(ctx(), provider=AuthProvider.PASSWORD, external_id="x") is None

    def test_found_with_null_roles(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=("i-1", "m-1", "secret", False, None, None)))
        row = TenantAuthRepository(router).find_identity(ctx(), provider=AuthProvider.PASSWORD, external_id="a")
        assert row.roles == []


class TestUpdateSecret:
    def test_executes_update(self):
        router = FakeRouter()
        router.queue(FakeCursor())
        TenantAuthRepository(router).update_secret(
            ctx(), provider=AuthProvider.PASSWORD, external_id="alice", secret="new", must_reset=False
        )
        assert "UPDATE auth_identity" in router.last_sql
