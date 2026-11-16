"""Manager-owned authentication session state.

The JWT remains the portable identity proof.  This store is the authoritative
online decision for whether that proof is still allowed to enter Manager.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from shared.contracts.auth import TokenClaims
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter


class ManagerAuthSessionRepository:
    def __init__(self, dsn: str):
        self._router = PgTenantRouter(dsn)

    def create(self, ctx: TenantContext, *, issued_at: datetime, expires_at: datetime) -> str:
        jti = str(uuid4())
        with self._router.session(ctx) as session:
            session.execute(
                "INSERT INTO manager_auth_session "
                "(tenant_id, jti, user_id, issued_at, expires_at) "
                "VALUES (%s, %s, %s, %s, %s)",
                (ctx.tenant_id, jti, ctx.user_id, issued_at, expires_at),
            )
        return jti

    def is_active(self, claims: TokenClaims) -> bool:
        if not claims.jti or not claims.tenant_id:
            return False
        ctx = TenantContext(tenant_id=claims.tenant_id, user_id=claims.user_id, roles=claims.roles)
        with self._router.session(ctx) as session:
            row = session.execute(
                "SELECT user_id, expires_at, revoked_at FROM manager_auth_session "
                "WHERE jti = %s",
                (claims.jti,),
            ).fetchone()
        if row is None or str(row[0]) != claims.user_id or row[2] is not None:
            return False
        expires_at = row[1]
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)
        return expires_at > datetime.now(UTC)

    def revoke(self, claims: TokenClaims, *, reason: str) -> None:
        if not claims.jti or not claims.tenant_id:
            return
        ctx = TenantContext(tenant_id=claims.tenant_id, user_id=claims.user_id, roles=claims.roles)
        with self._router.session(ctx) as session:
            session.execute(
                "UPDATE manager_auth_session SET revoked_at = COALESCE(revoked_at, now()), "
                "revoke_reason = COALESCE(revoke_reason, %s) "
                "WHERE jti = %s AND user_id = %s",
                (reason, claims.jti, claims.user_id),
            )

    def revoke_user(self, ctx: TenantContext, *, reason: str) -> None:
        with self._router.session(ctx) as session:
            session.execute(
                "UPDATE manager_auth_session SET revoked_at = COALESCE(revoked_at, now()), "
                "revoke_reason = COALESCE(revoke_reason, %s) "
                "WHERE user_id = %s AND revoked_at IS NULL",
                (reason, ctx.user_id),
            )

    def revoke_user_except(self, ctx: TenantContext, *, keep_jti: str, reason: str) -> None:
        """吊销该成员除 keep_jti 之外的所有有效会话（自助改密后其它设备须重新登录）。"""
        with self._router.session(ctx) as session:
            session.execute(
                "UPDATE manager_auth_session SET revoked_at = COALESCE(revoked_at, now()), "
                "revoke_reason = COALESCE(revoke_reason, %s) "
                "WHERE user_id = %s AND jti <> %s AND revoked_at IS NULL",
                (reason, ctx.user_id, keep_jti),
            )
