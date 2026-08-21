"""Manager RAG 租户隔离服务（04 §6.1.2，D21）。

workspace = derive(tenant_id, knowledge_space_id)，只能从 TenantContext 推导；前端/Agent/业务 API
都不得直传 workspace。PG workspace/tenant 映射表加 RLS 作第二防线（§6.1.2 第 6 条）。

本服务负责 Manager-owned workspace 派生与可审计映射表 + RLS；LightRAG 写入/读取均在此隔离边界外以受控客户端执行。
"""

from __future__ import annotations

from dataclasses import dataclass

from shared.contracts.tenancy import TenantContext
from shared.db import ManagerRagService, PgTenantRouter

from .rag_instances import RagInstance, RagInstanceConfigurationError, RagInstanceRegistry


@dataclass(frozen=True)
class RagHandle:
    """RAG 访问句柄，携带派生 workspace 与已验证的 startup instance_id。"""

    tenant_id: str
    knowledge_space_id: str
    workspace: str
    instance_id: str = "legacy"


class PgManagerRagService(ManagerRagService):
    """从 TenantContext 推导 workspace，并把映射落到加 RLS 的 PG 表（第二防线）。"""

    def __init__(self, dsn: str, *, instance_registry: RagInstanceRegistry | None = None):
        self._router = PgTenantRouter(dsn)
        # Startup callers may inject the already-loaded registry.  The default
        # path loads the same static Manager configuration used by the clients.
        self._instances = instance_registry if instance_registry is not None else RagInstanceRegistry.from_env()

    def get(self, ctx: TenantContext, knowledge_space_id: str) -> RagHandle:
        # 唯一派生入口：禁止外部直传 workspace（D21）。先解析可信 startup
        # registry，未知 workspace 不得在审计表留下半成品映射。
        workspace = self.derive_workspace(ctx.tenant_id, knowledge_space_id)
        instance = self._resolve_instance(workspace)
        instance_id = instance.instance_id if instance is not None else "legacy"
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO rag_workspace AS target "
                "(tenant_id, knowledge_space_id, workspace, instance_id) "
                "VALUES (%s, %s, %s, %s) "
                "ON CONFLICT (tenant_id, knowledge_space_id) DO UPDATE "
                "SET instance_id = CASE "
                "WHEN target.workspace = EXCLUDED.workspace "
                "THEN COALESCE(target.instance_id, EXCLUDED.instance_id) "
                "ELSE target.instance_id END "
                "RETURNING tenant_id, knowledge_space_id, workspace, instance_id",
                (ctx.tenant_id, knowledge_space_id, workspace, instance_id),
            ).fetchone()
            if (
                row is None
                or len(row) < 4
                or str(row[0]) != str(ctx.tenant_id)
                or row[1] != knowledge_space_id
                or row[2] != workspace
                or row[3] != instance_id
            ):
                # Existing non-null instance_id is immutable evidence of the
                # startup binding.  Never overwrite it after a restart/config
                # change; a workspace/tenant/instance drift fails closed.
                raise ValueError("knowledge service unavailable")
        return RagHandle(
            tenant_id=ctx.tenant_id,
            knowledge_space_id=knowledge_space_id,
            workspace=workspace,
            instance_id=instance_id,
        )

    def _resolve_instance(self, workspace: str) -> RagInstance | None:
        instances = getattr(self, "_instances", None)
        if instances is None:
            return None
        try:
            return instances.resolve(workspace)
        except RagInstanceConfigurationError as exc:
            raise ValueError("knowledge service unavailable") from exc

    def list_workspaces(self, ctx: TenantContext) -> list[dict]:
        """列出本 tenant 的 workspace 映射（受 RLS 约束，跨租户不可见）。"""
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT knowledge_space_id, workspace FROM rag_workspace ORDER BY created_at"
            ).fetchall()
        return [{"knowledge_space_id": r[0], "workspace": r[1]} for r in rows]
