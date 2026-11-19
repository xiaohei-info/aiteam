"""成员能力授权数据访问（设计 2026-11-19 审批策略与能力授权 §3.2 / §3.4）。

本机 Agent 在成员批准安装某个能力后上报一条授权（仅本会话有效）。Manager 侧只用它做一件事：
平台预登记的 MCP OAuth 应用密钥，仅在成员已授权时下发。

铁律（D22）：tenant_id 只从 TenantContext 读；RLS 强制隔离。
红线（D13）：只存「谁、哪个会话、哪个能力、什么来源」这类中立元数据，不存会话内容、不含令牌。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter

_COLUMNS = "id, tenant_id, member_id, conversation_id, capability_kind, capability_ref, source, scope, created_at"


@dataclass(frozen=True)
class MemberCapabilityGrantRow:
    grant_id: str
    tenant_id: str
    member_id: str
    conversation_id: str
    capability_kind: str
    capability_ref: str
    source: str
    scope: str
    created_at: datetime


def _row_to_grant(row: Any) -> MemberCapabilityGrantRow:
    return MemberCapabilityGrantRow(
        grant_id=str(row[0]),
        tenant_id=str(row[1]),
        member_id=row[2],
        conversation_id=row[3],
        capability_kind=row[4],
        capability_ref=row[5],
        source=row[6],
        scope=row[7],
        created_at=row[8],
    )


class MemberCapabilityGrantRepository:
    """成员能力授权的租户内读写。tenant_id 全程经 TenantContext（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def upsert(
        self,
        ctx: TenantContext,
        *,
        member_id: str,
        conversation_id: str,
        capability_kind: str,
        capability_ref: str,
        source: str = "",
        scope: str = "session",
    ) -> MemberCapabilityGrantRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO member_capability_grant "
                "(tenant_id, member_id, conversation_id, capability_kind, capability_ref, source, scope) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s) "
                "ON CONFLICT (tenant_id, member_id, conversation_id, capability_kind, capability_ref) "
                "DO UPDATE SET source = EXCLUDED.source "
                "RETURNING " + _COLUMNS,
                (UUID(ctx.tenant_id), member_id, conversation_id, capability_kind, capability_ref, source, scope),
            ).fetchone()
        return _row_to_grant(row)

    def delete_conversation(self, ctx: TenantContext, *, member_id: str, conversation_id: str) -> int:
        with self._router.session(ctx) as s:
            return s.execute(
                "DELETE FROM member_capability_grant WHERE tenant_id = %s AND member_id = %s AND conversation_id = %s",
                (UUID(ctx.tenant_id), member_id, conversation_id),
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
