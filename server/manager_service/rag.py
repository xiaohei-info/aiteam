"""Manager-owned enterprise RAG routing (04 §6.1.2, D21).

A Manager deployment serves one enterprise and routes every enterprise document
through one startup-fixed LightRAG workspace.  Existing tenant/space keys remain
only as database/citation compatibility metadata; callers never choose a raw
workspace or a second enterprise.
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
    """Route one enterprise workspace and retain legacy internal key mappings."""

    def __init__(
        self,
        dsn: str,
        *,
        instance_registry: RagInstanceRegistry | None = None,
        enterprise_workspace: str | None = None,
        enterprise_id: str | None = None,
    ):
        self._router = PgTenantRouter(dsn)
        # Startup callers may inject the already-loaded registry.  The default
        # path loads the same static Manager configuration used by the clients.
        self._instances = instance_registry if instance_registry is not None else RagInstanceRegistry.from_env()
        self._enterprise_workspace = enterprise_workspace or (
            self._instances.instances[0].workspace if self._instances is not None else None
        )
        self._enterprise_id = enterprise_id or os.getenv("AITEAM_MANAGER_TENANT_ID") or os.getenv("AITEAM_MANAGER_ENTERPRISE_ID") or None
        self._enterprise_space_id = enterprise_knowledge_space_id(self._enterprise_workspace)

    @property
    def default_space_id(self) -> str:
        return getattr(self, "_enterprise_space_id", DEFAULT_ENTERPRISE_KNOWLEDGE_SPACE_ID)

    @property
    def is_enterprise_scope(self) -> bool:
        return bool(getattr(self, "_enterprise_workspace", None))

    def get(self, ctx: TenantContext, knowledge_space_id: str) -> RagHandle:
        # A Manager process serves one enterprise.  Keep the legacy key in the
        # handle for existing citations/bindings, but never route a second space.
        enterprise_workspace = getattr(self, "_enterprise_workspace", None)
        enterprise_id = getattr(self, "_enterprise_id", None)
        if enterprise_workspace:
            if enterprise_id and str(ctx.tenant_id) != str(enterprise_id):
                raise ValueError("knowledge service unavailable")
            if knowledge_space_id != self.default_space_id:
                # Existing citations/bindings may carry a legacy internal key;
                # accept it only when the Manager DB already knows that key.
                with self._router.session(ctx) as s:
                    legacy = s.execute(
                        "SELECT 1 FROM rag_workspace WHERE knowledge_space_id = %s",
                        (knowledge_space_id,),
                    ).fetchone()
                if legacy is None:
                    raise ValueError("knowledge service unavailable")
            workspace = enterprise_workspace
        else:
            # Compatibility for isolated unit tests and unconfigured development.
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
