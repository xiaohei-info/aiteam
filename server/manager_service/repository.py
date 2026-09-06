"""租户作用域数据访问（04 §6.1.1/§6.1.3，D22）。

铁律：所有 tenant 数据访问都经 TenantContext → PgTenantRouter.session（SET LOCAL app.tenant_id
+ RLS），repository **只从 TenantContext 读 tenant_id**，绝不接受调用方手写 tenant 过滤字符串。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from shared.contracts.enums import AuthProvider
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter


@dataclass(frozen=True)
class IdentityRow:
    identity_id: str
    user_id: str
    secret: str | None
    must_reset: bool
    roles: list[str]
    password_changed_at: datetime | float | None = None
    status: str = "active"


class TenantAuthRepository:
    """auth_identity / app_user 的租户内访问。所有方法以 TenantContext 为隔离边界。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def create_user_with_identity(
        self,
        ctx: TenantContext,
        *,
        provider: AuthProvider,
        external_id: str,
        secret: str,
        roles: list[str],
        display_name: str,
        must_reset: bool,
    ) -> str:
        """在本 tenant 建 user + auth_identity；返回 user_id。tenant_id 取自 ctx（D22）。"""
        with self._router.session(ctx) as s:
            user_id = s.execute(
                "INSERT INTO app_user (tenant_id, display_name, roles) VALUES (%s, %s, %s) RETURNING id",
                (ctx.tenant_id, display_name, roles),
            ).fetchone()[0]
            s.execute(
                "INSERT INTO auth_identity "
                "(tenant_id, user_id, provider, external_id, secret, must_reset, password_changed_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, now())",
                (ctx.tenant_id, str(user_id), provider.value, external_id, secret, must_reset),
            )
            return str(user_id)

    def find_identity(self, ctx: TenantContext, *, provider: AuthProvider, external_id: str) -> IdentityRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT ai.id, ai.user_id, ai.secret, ai.must_reset, "
                "       ai.password_changed_at, u.roles, u.status "
                "FROM auth_identity ai JOIN app_user u ON u.id = ai.user_id "
                "WHERE ai.provider = %s AND ai.external_id = %s",
                (provider.value, external_id),
            ).fetchone()
        if row is None:
            return None
        return IdentityRow(
            identity_id=str(row[0]),
            user_id=str(row[1]),
            secret=row[2],
            must_reset=row[3],
            password_changed_at=row[4],
            roles=list(row[5] or []), status=row[6],
        )


    def find_user(self, ctx: TenantContext, *, user_id: str) -> IdentityRow | None:
        """按 user_id 取规范账号（含 roles）。tenant_id 发自 ctx。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT ai.id, ai.user_id, ai.secret, ai.must_reset, ai.password_changed_at, u.roles, u.status "
                "FROM auth_identity ai JOIN app_user u ON u.id = ai.user_id "
                "WHERE ai.user_id = %s ORDER BY (ai.provider IN ('phone', 'password')) DESC, ai.id LIMIT 1",
                (user_id,),
            ).fetchone()
        if row is None:
            return None
        return IdentityRow(
            identity_id=str(row[0]), user_id=str(row[1]),
            secret=row[2], must_reset=row[3], password_changed_at=row[4],
            roles=list(row[5] or []), status=row[6],
        )

    def find_or_create_passkey_identity(self, ctx: TenantContext, *, user_id: str) -> None:
        """确保该 user 有一条 provider=passkey 的 auth_identity；已存在则跳过（幂等）。
        passkey 无需 secret；external_id 仅作占位（唯一同 user_id 即可）。"""
        with self._router.session(ctx) as s:
            existing = s.execute(
                "SELECT 1 FROM auth_identity WHERE user_id = %s AND provider = %s",
                (user_id, AuthProvider.PASSKEY.value),
            ).fetchone()
            if existing:
                return
            external_id = "passkey:" + str(user_id)
            s.execute(
                "INSERT INTO auth_identity "
                "  (tenant_id, user_id, provider, external_id, secret, must_reset) "
                "VALUES (%s, %s, %s, %s, NULL, false) "
                "ON CONFLICT (tenant_id, provider, external_id) DO NOTHING",
                (ctx.tenant_id, user_id, AuthProvider.PASSKEY.value, external_id),
            )

    def find_oauth_identity(self, ctx: TenantContext, *, external_id: str) -> IdentityRow | None:
        """按 provider=oauth + external_id（三方 sub）定位身份；用于 OAuth 登录。"""
        return self.find_identity(ctx, provider=AuthProvider.OAUTH, external_id=external_id)

    def upsert_oauth_identity(self, ctx: TenantContext, *, user_id: str, external_id: str) -> None:
        """确保该 user 有一条 provider=oauth + external_id 的 auth_identity；已存在则跳过（幂等）。"""
        with self._router.session(ctx) as s:
            existing = s.execute(
                "SELECT 1 FROM auth_identity WHERE tenant_id = %s AND provider = %s AND external_id = %s",
                (ctx.tenant_id, AuthProvider.OAUTH.value, external_id),
            ).fetchone()
            if existing:
                return
            s.execute(
                "INSERT INTO auth_identity "
                "  (tenant_id, user_id, provider, external_id, secret, must_reset) "
                "VALUES (%s, %s, %s, %s, NULL, false)",
                (ctx.tenant_id, user_id, AuthProvider.OAUTH.value, external_id),
            )


    def update_secret(
        self, ctx: TenantContext, *, provider: AuthProvider, external_id: str, secret: str, must_reset: bool
    ) -> None:
        with self._router.session(ctx) as s:
            s.execute(
                "UPDATE auth_identity SET secret = %s, must_reset = %s, password_changed_at = now() "
                "WHERE provider = %s AND external_id = %s",
                (secret, must_reset, provider.value, external_id),
            )
