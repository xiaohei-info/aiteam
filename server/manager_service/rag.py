"""Manager RAG 租户隔离服务（04 §6.1.2，D21）。

workspace = derive(tenant_id, knowledge_space_id)，只能从 TenantContext 推导；前端/Agent/业务 API
都不得直传 workspace。PG workspace/tenant 映射表加 RLS 作第二防线（§6.1.2 第 6 条）。

本服务负责 Manager-owned workspace 派生与可审计映射表 + RLS；LightRAG 写入/读取均在此隔离边界外以受控客户端执行。
"""

from __future__ import annotations

from dataclasses import dataclass

from shared.contracts.tenancy import TenantContext
from shared.db import ManagerRagService, PgTenantRouter


@dataclass(frozen=True)
class RagHandle:
    """RAG 访问句柄，携带仅由 Manager 推导的 workspace。"""

    tenant_id: str
    knowledge_space_id: str
    workspace: str


class PgManagerRagService(ManagerRagService):
    """从 TenantContext 推导 workspace，并把映射落到加 RLS 的 PG 表（第二防线）。"""

    def __init__(self, dsn: str):
        self._router = PgTenantRouter(dsn)

    def get(self, ctx: TenantContext, knowledge_space_id: str) -> RagHandle:
        # 唯一派生入口：禁止外部直传 workspace（D21）。
        workspace = self.derive_workspace(ctx.tenant_id, knowledge_space_id)
        with self._router.session(ctx) as s:
            s.execute(
                "INSERT INTO rag_workspace (tenant_id, knowledge_space_id, workspace) "
                "VALUES (%s, %s, %s) ON CONFLICT (tenant_id, knowledge_space_id) DO NOTHING",
                (ctx.tenant_id, knowledge_space_id, workspace),
            )
        return RagHandle(tenant_id=ctx.tenant_id, knowledge_space_id=knowledge_space_id, workspace=workspace)

    def list_workspaces(self, ctx: TenantContext) -> list[dict]:
        """列出本 tenant 的 workspace 映射（受 RLS 约束，跨租户不可见）。"""
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT knowledge_space_id, workspace FROM rag_workspace ORDER BY created_at"
            ).fetchall()
        return [{"knowledge_space_id": r[0], "workspace": r[1]} for r in rows]
