"""Manager-owned tenant-scoped RAG routing (04 §6.1.2, D21).

The Manager endpoint registry contains only LightRAG URL/credential entries.
Each tenant's enterprise knowledge key resolves to a persisted or deterministic
workspace under that tenant; callers never choose a raw workspace.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
import re

from shared.contracts.tenancy import TenantContext
from shared.db import ManagerRagService, PgTenantRouter

from .rag_instances import RagInstance, RagInstanceConfigurationError, RagInstanceRegistry

DEFAULT_ENTERPRISE_KNOWLEDGE_SPACE_ID = "enterprise_shared"
_SAFE_SPACE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


def enterprise_knowledge_space_id(workspace: str | None = None) -> str:
    """Return the deployment-local internal key for the single enterprise KB."""
    configured = os.getenv("AITEAM_ENTERPRISE_KNOWLEDGE_SPACE_ID", "").strip()
    if configured and _SAFE_SPACE_ID.fullmatch(configured):
        return configured
    if isinstance(workspace, str) and "__" in workspace:
        suffix = workspace.rsplit("__", 1)[1].strip()
        if _SAFE_SPACE_ID.fullmatch(suffix):
            return suffix
    return DEFAULT_ENTERPRISE_KNOWLEDGE_SPACE_ID


@dataclass(frozen=True)
class RagHandle:
    """RAG 访问句柄，携带派生 workspace 与已验证的 startup instance_id。"""

    tenant_id: str
    knowledge_space_id: str
    workspace: str
    instance_id: str = "legacy"


class PgManagerRagService(ManagerRagService):
    """Route tenant-owned workspaces and retain legacy internal key mappings."""

    def __init__(
        self,
        dsn: str,
        *,
        instance_registry: RagInstanceRegistry | None = None,
    ):
        self._router = PgTenantRouter(dsn)
        # Startup callers may inject the already-loaded endpoint pool.  The
        # pool carries URL/credential identity only; workspace routing is below.
        self._instances = instance_registry if instance_registry is not None else RagInstanceRegistry.from_env()

    @property
    def default_space_id(self) -> str:
        return DEFAULT_ENTERPRISE_KNOWLEDGE_SPACE_ID

    def get(self, ctx: TenantContext, knowledge_space_id: str) -> RagHandle:
        if not isinstance(knowledge_space_id, str) or not knowledge_space_id.strip():
            raise ValueError("knowledge service unavailable")

        # Existing rows are authoritative for legacy aliases and preserve their
        # workspace/instance mapping. A missing key derives only the canonical
        # enterprise workspace; unknown legacy keys cannot create new mappings.
        with self._router.session(ctx) as s:
            existing = s.execute(
                "SELECT workspace, instance_id FROM rag_workspace WHERE knowledge_space_id = %s",
                (knowledge_space_id,),
            ).fetchone()
        if existing is None:
            if knowledge_space_id != self.default_space_id:
                raise ValueError("knowledge service unavailable")
            workspace = self.derive_workspace(ctx.tenant_id, knowledge_space_id)
            stored_instance_id = None
        else:
            if len(existing) < 1 or not isinstance(existing[0], str) or not existing[0].strip():
                raise ValueError("knowledge service unavailable")
            workspace = existing[0]
            stored_instance_id = existing[1] if len(existing) > 1 else None

        instance = self._resolve_instance(workspace)
        if instance is None:
            instance_id = str(stored_instance_id or "legacy")
        else:
            if stored_instance_id and str(stored_instance_id) != instance.instance_id:
                raise ValueError("knowledge service unavailable")
            instance_id = instance.instance_id

        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO rag_workspace AS target "
                "(tenant_id, knowledge_space_id, workspace, instance_id) "
                "VALUES (%s, %s, %s, %s) "
                "ON CONFLICT (tenant_id, knowledge_space_id) DO UPDATE "
                "SET workspace = target.workspace, instance_id = COALESCE(target.instance_id, EXCLUDED.instance_id) "
                "RETURNING tenant_id, knowledge_space_id, workspace, instance_id",
                (ctx.tenant_id, knowledge_space_id, workspace, instance_id),
            ).fetchone()
            if (
                row is None
                or len(row) < 4
                or str(row[0]) != str(ctx.tenant_id)
                or row[1] != knowledge_space_id
                or row[2] != workspace
                or str(row[3] or "legacy") != instance_id
            ):
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
