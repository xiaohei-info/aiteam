"""成员能力授权数据访问（设计 2026-11-19 审批策略与能力授权 §3.2 / §3.4）。

记录「成员本机装着哪个企业 MCP」：安装企业目录 MCP 时本机 Agent 上报，卸载时删除；
生命周期跟着安装走，不跟会话走。Manager 侧只用它做一件事：平台预登记的 MCP OAuth
应用密钥，只下发给装着该 MCP 的成员本机。capability_ref 存平台 server_id。

铁律（D22）：tenant_id 只从 TenantContext 读；RLS 强制隔离。
红线（D13）：只存「谁、哪个能力」这类中立元数据，不存会话内容、不含令牌。
"""

from __future__ import annotations

from uuid import UUID

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter


class MemberCapabilityGrantRepository:
    """成员能力授权的租户内读写。tenant_id 全程经 TenantContext（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def upsert(self, ctx: TenantContext, *, member_id: str, capability_kind: str, capability_ref: str) -> None:
        with self._router.session(ctx) as s:
            s.execute(
                "INSERT INTO member_capability_grant (tenant_id, member_id, capability_kind, capability_ref) "
                "VALUES (%s, %s, %s, %s) "
                "ON CONFLICT (tenant_id, member_id, capability_kind, capability_ref) DO NOTHING",
                (UUID(ctx.tenant_id), member_id, capability_kind, capability_ref),
            )

    def delete(self, ctx: TenantContext, *, member_id: str, capability_kind: str, capability_ref: str) -> int:
        with self._router.session(ctx) as s:
            return s.execute(
                "DELETE FROM member_capability_grant "
                "WHERE tenant_id = %s AND member_id = %s AND capability_kind = %s AND capability_ref = %s",
                (UUID(ctx.tenant_id), member_id, capability_kind, capability_ref),
            ).rowcount

    def has(self, ctx: TenantContext, *, member_id: str, capability_kind: str, capability_ref: str) -> bool:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT 1 FROM member_capability_grant "
                "WHERE tenant_id = %s AND member_id = %s AND capability_kind = %s AND capability_ref = %s LIMIT 1",
                (UUID(ctx.tenant_id), member_id, capability_kind, capability_ref),
            ).fetchone()
        return row is not None


def build_member_capability_grant_repository(router: PgTenantRouter) -> MemberCapabilityGrantRepository:
    return MemberCapabilityGrantRepository(router)
