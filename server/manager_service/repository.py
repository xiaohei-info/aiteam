"""租户作用域数据访问（04 §6.1.1/§6.1.3，D22）。

铁律：所有 tenant 数据访问都经 TenantContext → PgTenantRouter.session（SET LOCAL app.tenant_id
+ RLS），repository **只从 TenantContext 读 tenant_id**，绝不接受调用方手写 tenant 过滤字符串。
"""

from __future__ import annotations

from dataclasses import dataclass

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
                "(tenant_id, user_id, provider, external_id, secret, must_reset) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                (ctx.tenant_id, str(user_id), provider.value, external_id, secret, must_reset),
            )
            return str(user_id)

    def find_identity(self, ctx: TenantContext, *, provider: AuthProvider, external_id: str) -> IdentityRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT ai.id, ai.user_id, ai.secret, ai.must_reset, u.roles "
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
            roles=list(row[4] or []),
        )

    def update_secret(
        self, ctx: TenantContext, *, provider: AuthProvider, external_id: str, secret: str, must_reset: bool
    ) -> None:
        with self._router.session(ctx) as s:
            s.execute(
                "UPDATE auth_identity SET secret = %s, must_reset = %s "
                "WHERE provider = %s AND external_id = %s",
                (secret, must_reset, provider.value, external_id),
            )
