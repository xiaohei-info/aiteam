"""企业级本地审计日志数据访问（M7-followup #87，04「审计日志」/ 05 F16，D13/D22）。

铁律（与 UsageAuditQuotaRepository 一致，D22）：
- 以 TenantContext 为隔离边界，tenant_id 只从 ctx 读，SQL 不接受调用方手写 tenant 过滤。
- RLS 强制跨租户隔离（04 §6.1.1）；enterprise_audit 为租户作用域表。

红线（D13）：
- 只写事件级元数据（actor/action/resource_type/resource_id/拒因摘要）；绝不写会话文本/
  prompt/token 明文/执行配置内容。本仓库不提供任何承载会话内容的字段。
- 与 audit_summary_event（消费 Agent 上报的脱敏 rollup）语义不同：本表是 Manager 本端
  enforcement 时产生的审计，不可混用。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter

_COLUMNS = "id, tenant_id, actor, action, resource_type, resource_id, detail, occurred_at"


@dataclass(frozen=True)
class EnterpriseAuditRow:
    """企业本地审计行。无会话内容字段（D13）。"""

    audit_id: str
    tenant_id: str
    actor: str
    action: str
    resource_type: str | None
    resource_id: str | None
    detail: str | None
    occurred_at: datetime


def _row_to_audit(row: Any) -> EnterpriseAuditRow:
    return EnterpriseAuditRow(
        audit_id=str(row[0]),
        tenant_id=str(row[1]),
        actor=row[2],
        action=row[3],
        resource_type=row[4],
        resource_id=row[5],
        detail=row[6],
        occurred_at=row[7],
    )


class EnterpriseAuditRepository:
    """企业本地审计日志的租户内写入/检索。

    tenant_id 全程经 TenantContext（D22）；跨租户因 RLS 不可见（04 §6.1.1）。
    """

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def record(
        self,
        ctx: TenantContext,
        *,
        actor: str,
        action: str,
        resource_type: str | None = None,
        resource_id: str | None = None,
        detail: str | None = None,
    ) -> EnterpriseAuditRow:
        """落一条本端审计事件。tenant_id 取自 ctx（D22，RLS WITH CHECK 兜底）。

        调用方只传中立元数据；本方法不接受、不存储任何会话/配置内容字段（D13）。
        """
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO enterprise_audit "
                "(tenant_id, actor, action, resource_type, resource_id, detail) "
                "VALUES (%s, %s, %s, %s, %s, %s) "
                "RETURNING " + _COLUMNS,
                (UUID(ctx.tenant_id), actor, action, resource_type, resource_id, detail),
            ).fetchone()
        return _row_to_audit(row)

    def list_all(self, ctx: TenantContext) -> list[EnterpriseAuditRow]:
        """列本 tenant 内全部审计事件（RLS 自动限定），按时间倒序。"""
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _COLUMNS + " FROM enterprise_audit ORDER BY occurred_at DESC"
            ).fetchall()
        return [_row_to_audit(r) for r in rows]


def build_enterprise_audit_repository(router: PgTenantRouter) -> EnterpriseAuditRepository:
    return EnterpriseAuditRepository(router)
