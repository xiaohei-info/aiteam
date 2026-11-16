"""R8/R9 新增仓储方法的单元测试（非 integration，FakeRouter）：覆盖 SQL 参数与空行分支。"""

from __future__ import annotations

import pytest

from shared.contracts.enums import AuthProvider

from manager_service.auth_sessions import ManagerAuthSessionRepository
from manager_service.login_audit import LoginAuditRepository
from manager_service.repository import TenantAuthRepository

from ._fake_router import FakeCursor, FakeRouter, ctx


def test_find_account_summary_prefers_phone_and_reports_password_flag():
    router = FakeRouter().queue(FakeCursor(fetchone=("13812345678", True)))
    assert TenantAuthRepository(router).find_account_summary(ctx(), user_id="u-1") == ("13812345678", True)
    sql, params = router.executed[-1]
    assert "provider IN ('phone', 'password')" in sql
    assert params == ("u-1",)


def test_find_account_summary_returns_none_without_identity():
    router = FakeRouter().queue(FakeCursor())
    assert TenantAuthRepository(router).find_account_summary(ctx(), user_id="u-1") is None


def test_update_secret_for_user_only_touches_local_password_identities():
    router = FakeRouter()
    TenantAuthRepository(router).update_secret_for_user(ctx(), user_id="u-1", secret="hash")
    sql, params = router.executed[-1]
    assert "provider IN ('phone', 'password') AND secret IS NOT NULL" in sql
    assert "must_reset = false" in sql
    assert params == ("hash", "u-1")


def test_create_user_fails_loudly_when_insert_returns_no_row():
    router = FakeRouter().queue(FakeCursor())
    repo = TenantAuthRepository(router)
    with pytest.raises(RuntimeError, match="app_user insert returned no row"):
        repo.create_user_with_identity(
            ctx(), provider=AuthProvider.PHONE, external_id="x", secret="h", roles=["member"], display_name="n", must_reset=False,
        )


def test_revoke_user_except_keeps_the_current_session():
    router = FakeRouter()
    repo = ManagerAuthSessionRepository.__new__(ManagerAuthSessionRepository)
    repo._router = router
    repo.revoke_user_except(ctx(user_id="u-9"), keep_jti="jti-now", reason="password_changed")
    sql, params = router.executed[-1]
    assert "jti <> %s" in sql and "revoked_at IS NULL" in sql
    assert params == ("password_changed", "u-9", "jti-now")


@pytest.mark.parametrize("row,expected", [((3,), 3), (None, 0)])
def test_count_recent_failures_reads_count_or_zero(row, expected):
    router = FakeRouter().queue(FakeCursor(fetchone=row))
    audit = LoginAuditRepository(router)
    assert audit.count_recent_failures(ctx(), actor="u-1", detail="change_password", within_minutes=15) == expected
    sql, params = router.executed[-1]
    assert "success = false" in sql
    assert params == ("u-1", "change_password", 15, "u-1", "change_password")
