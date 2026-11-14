"""R4 真实 PG：重置已有负责人凭据时，在 RLS + app_rw 下同事务清掉会话、passkey 与第三方登录。

只动被重置的那一个 user_id；同租户其他成员、其他租户的数据不受影响。
"""
from __future__ import annotations

import uuid

import pytest

from manager_service.auth_service import build_auth_service
from manager_service.idempotency_repository import ManagerIdempotencyRepository
from shared.contracts.enums import AuthProvider
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter

pytestmark = pytest.mark.integration

BOOTSTRAP = "Bqkzwl-Nvrt-3"
RESET = "Hmpxqa-Lcws-8"


def _ctx(tenant_id: str) -> TenantContext:
    return TenantContext(tenant_id=tenant_id, user_id="system", roles=["owner"])


def _seed_credentials(router: PgTenantRouter, tenant_id: str, user_id: str) -> None:
    tag = uuid.uuid4().hex
    with router.session(_ctx(tenant_id)) as s:
        s.execute(
            "INSERT INTO manager_auth_session (tenant_id, jti, user_id, issued_at, expires_at) "
            "VALUES (%s, %s, %s, now(), now() + interval '1 hour')",
            (tenant_id, str(uuid.uuid4()), user_id),
        )
        s.execute(
            "INSERT INTO passkey_credential (tenant_id, user_id, credential_id, public_key_pem) VALUES (%s, %s, %s, 'pem')",
            (tenant_id, user_id, f"cred-{tag}"),
        )
        s.execute(
            "INSERT INTO oauth_connection (tenant_id, user_id, provider, provider_user_id) VALUES (%s, %s, 'github', %s)",
            (tenant_id, user_id, f"gh-{tag}"),
        )
        s.execute(
            "INSERT INTO auth_identity (tenant_id, user_id, provider, external_id) VALUES (%s, %s, %s, %s)",
            (tenant_id, user_id, AuthProvider.OAUTH.value, f"github:{tag}"),
        )


def _counts(router: PgTenantRouter, tenant_id: str, user_id: str) -> dict[str, int]:
    with router.session(_ctx(tenant_id)) as s:
        cur = s.execute(
            "SELECT "
            " (SELECT count(*) FROM manager_auth_session WHERE user_id = %s AND revoked_at IS NULL),"
            " (SELECT count(*) FROM passkey_credential WHERE user_id = %s),"
            " (SELECT count(*) FROM oauth_connection WHERE user_id = %s),"
            " (SELECT count(*) FROM auth_identity WHERE user_id = %s AND provider = %s)",
            (user_id, user_id, user_id, user_id, AuthProvider.OAUTH.value),
        )
        assert cur is not None
        row = cur.fetchone()
        assert row is not None
    keys = ("active_sessions", "passkeys", "oauth_connections", "oauth_identities")
    return dict(zip(keys, (int(v) for v in row)))


ALL_PRESENT = {"active_sessions": 1, "passkeys": 1, "oauth_connections": 1, "oauth_identities": 1}
ALL_CLEARED = {"active_sessions": 0, "passkeys": 0, "oauth_connections": 0, "oauth_identities": 0}


def test_owner_reset_clears_only_the_owner_credentials_under_rls(migrated_db, admin_url, two_tenants):
    tenant_a, tenant_b = two_tenants
    auth = build_auth_service(migrated_db, admin_url)
    router = PgTenantRouter(migrated_db)
    owner_phone = "owner-" + uuid.uuid4().hex[:10]
    owner_a = str(auth.provision_owner(tenant_a, phone=owner_phone, bootstrap_password=BOOTSTRAP))
    member_a = str(auth.create_member(tenant_a, phone="member-" + uuid.uuid4().hex[:10], initial_password=BOOTSTRAP))
    owner_b = str(auth.provision_owner(tenant_b, phone="owner-" + uuid.uuid4().hex[:10], bootstrap_password=BOOTSTRAP))
    for tenant_id, user_id in ((tenant_a, owner_a), (tenant_a, member_a), (tenant_b, owner_b)):
        _seed_credentials(router, tenant_id, user_id)

    result = auth.sync_owner_bootstrap_idempotent(
        tenant_a, phone=owner_phone, bootstrap_password=RESET, must_reset=True,
        idempotency_repository=ManagerIdempotencyRepository(router),
        idempotency_key="reset-" + uuid.uuid4().hex, request_fingerprint="fp",
    )

    assert result.payload["user_id"] == owner_a
    assert result.payload["cleared"] == {"sessions": 1, "passkeys": 1, "oauth": 2}
    assert _counts(router, tenant_a, owner_a) == ALL_CLEARED
    assert _counts(router, tenant_a, member_a) == ALL_PRESENT
    assert _counts(router, tenant_b, owner_b) == ALL_PRESENT
    identity = auth._repo.find_identity(_ctx(tenant_a), provider=AuthProvider.PHONE, external_id=owner_phone)
    assert identity is not None and identity.must_reset is True
