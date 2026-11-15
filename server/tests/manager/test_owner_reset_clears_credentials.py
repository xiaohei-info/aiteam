"""重置负责人凭据（F02 replace）：同一事务内吊销该负责人的会话、清除 passkey 与第三方登录；只影响这一个用户。"""

from __future__ import annotations

from typing import Any, cast

from manager_service.auth_service import AuthService
from manager_service.repository import TenantAuthRepository

from ._fake_router import FakeCursor, FakeRouter, ctx

PHONE = "13800000000"


class _Idempotency:
    """只负责把 effect 交给一个共享 session 执行，模拟「回执与凭据变更同一事务」。"""

    def __init__(self, router: FakeRouter):
        self.router = router

    def execute(self, c, *, operation, idempotency_key, request_fingerprint, effect, status_code=200):
        class _Result:
            payload = effect(self.router.session(c))
        return _Result()


def _service(router: FakeRouter) -> AuthService:
    service = object.__new__(AuthService)
    service._repo = TenantAuthRepository(cast(Any, router))
    return service


def _bootstrap(router: FakeRouter):
    return _service(router).sync_owner_bootstrap_idempotent(
        ctx().tenant_id, phone=PHONE, bootstrap_password="Abcdef1!ghij", must_reset=True,
        idempotency_repository=_Idempotency(router), idempotency_key="k1", request_fingerprint="fp",
    ).payload


def test_clear_user_credentials_scopes_every_statement_to_the_user_and_counts_rows():
    router = FakeRouter().queue_many(
        FakeCursor(rowcount=2), FakeCursor(rowcount=1), FakeCursor(rowcount=3), FakeCursor(rowcount=1),
    )
    cleared = TenantAuthRepository(cast(Any, router)).clear_user_credentials_in_session(router.session(ctx()), ctx(), user_id="owner-1")
    assert cleared == {"sessions": 2, "passkeys": 1, "oauth": 4}
    statements = [sql for sql, _ in router.executed]
    assert "manager_auth_session" in statements[0] and "revoked_at IS NULL" in statements[0]
    assert "passkey_credential" in statements[1]
    assert "oauth_connection" in statements[2]
    assert "auth_identity" in statements[3] and "provider" in statements[3]
    for sql, params in router.executed:
        assert "user_id = %s" in sql and "owner-1" in params


def test_replacing_an_existing_owner_clears_that_owners_credentials_in_the_same_session():
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=("owner-1", "active")), FakeCursor(),  # 查身份 + 更新密码
        FakeCursor(rowcount=2), FakeCursor(rowcount=1), FakeCursor(rowcount=0), FakeCursor(rowcount=1),
    )
    payload = _bootstrap(router)
    assert payload == {
        "tenant_id": ctx().tenant_id, "user_id": "owner-1", "cleared": {"sessions": 2, "passkeys": 1, "oauth": 1},
    }
    assert any("manager_auth_session" in sql for sql, _ in router.executed)


def test_first_time_provisioning_clears_nothing_and_reports_no_counts():
    router = FakeRouter().queue_many(FakeCursor(fetchone=None), FakeCursor(fetchone=("owner-1",)), FakeCursor())
    payload = _bootstrap(router)
    assert payload == {"tenant_id": ctx().tenant_id, "user_id": "owner-1"}
    assert not any("DELETE" in sql or "manager_auth_session" in sql for sql, _ in router.executed)
