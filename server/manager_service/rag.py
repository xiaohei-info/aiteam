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


def legacy_knowledge_space_id(workspace: str | None) -> str | None:
    """Extract an old workspace-suffix key without consulting process config."""
    if not isinstance(workspace, str) or "__" not in workspace:
        return None
    suffix = workspace.rsplit("__", 1)[1].strip()
    return suffix if _SAFE_SPACE_ID.fullmatch(suffix) else None


def workspace_is_tenant_scoped(tenant_id: str, workspace: str | None, knowledge_space_id: str) -> bool:
    """Accept only the current tenant's derived or legacy-suffixed workspace."""
    if not isinstance(workspace, str) or not workspace.strip():
        return False
    expected = ManagerRagService.derive_workspace(tenant_id, knowledge_space_id)
    if workspace == expected:
        return True
    prefix = f"t{str(tenant_id).replace('-', '')}__"
    return workspace.startswith(prefix) and legacy_knowledge_space_id(workspace) == knowledge_space_id


def enterprise_knowledge_space_id(workspace: str | None = None) -> str:
    """Return the configured/default internal key for the enterprise KB."""
    configured = os.getenv("AITEAM_ENTERPRISE_KNOWLEDGE_SPACE_ID", "").strip()
    if configured and _SAFE_SPACE_ID.fullmatch(configured):
        return configured
    legacy = legacy_knowledge_space_id(workspace)
    return legacy or DEFAULT_ENTERPRISE_KNOWLEDGE_SPACE_ID


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
        return enterprise_knowledge_space_id()

    def default_space_id_for(self, ctx: TenantContext) -> str | None:
        """Resolve the canonical or one unambiguous legacy enterprise key."""
        configured = enterprise_knowledge_space_id()
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT knowledge_space_id, workspace FROM rag_workspace ORDER BY created_at"
            ).fetchall()
        for row in rows:
            if row[0] == configured:
                return (
                    configured
                    if len(row) > 1
                    and workspace_is_tenant_scoped(ctx.tenant_id, row[1], configured)
                    else None
                )
        candidates = {
            row[0]
            for row in rows
            if len(row) > 1
            and isinstance(row[0], str)
            and workspace_is_tenant_scoped(ctx.tenant_id, row[1], row[0])
            and legacy_knowledge_space_id(row[1]) == row[0]
        }
        if len(candidates) == 1:
            return next(iter(candidates))
        # Any existing row is authoritative, even when malformed or from the
        # retired fixed-workspace scheme. Do not create a new canonical alias
        # that would silently hide retained legacy data; only a truly empty
        # tenant mapping may bootstrap the canonical key.
        return configured if not rows else None

    def is_enterprise_space(self, ctx: TenantContext, space_id: str) -> bool:
        if space_id == enterprise_knowledge_space_id():
            # A snapshot may carry the canonical compatibility key even when
            # the tenant has only a retired/malformed mapping. Re-resolve the
            # persisted mapping instead of treating the key as unconditional.
            return self.default_space_id_for(ctx) == space_id
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT workspace FROM rag_workspace WHERE knowledge_space_id = %s",
                (space_id,),
            ).fetchone()
        return bool(
            row
            and workspace_is_tenant_scoped(ctx.tenant_id, row[0], space_id)
            and legacy_knowledge_space_id(row[0]) == space_id
        )

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
            if not workspace_is_tenant_scoped(ctx.tenant_id, workspace, knowledge_space_id):
                raise ValueError("knowledge service unavailable")

        instances = getattr(self, "_instances", None)
        if instances is None:
            # Disabled LightRAG is read-only for already persisted mappings. A
            # missing mapping must not create the synthetic ``legacy`` instance
            # record that would block later pool bootstrap/reconciliation.
            if existing is None:
                raise ValueError("knowledge service unavailable")
            return RagHandle(
                tenant_id=ctx.tenant_id,
                knowledge_space_id=knowledge_space_id,
                workspace=workspace,
                instance_id=str(stored_instance_id or "legacy"),
            )
        if instances is not None and stored_instance_id:
            # A persisted instance_id is historical routing evidence. Reuse it
            # directly rather than re-hashing the workspace after a pool/order
            # change; an unknown id fails closed instead of silently rerouting.
            instance = self._resolve_instance(workspace, instance_id=str(stored_instance_id))
        elif instances is not None and existing is not None and len(instances.instances) > 1:
            # NULL has no endpoint provenance. Only rows created through the
            # registry-aware repository receive an instance_id; every existing
            # NULL row is legacy and must be reconciled instead of guessed.
            raise ValueError("knowledge service unavailable")
        else:
            instance = self._resolve_instance(workspace)
        if instance is None:
            instance_id = str(stored_instance_id or "legacy")
        else:
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

    def _resolve_instance(self, workspace: str, *, instance_id: str | None = None) -> RagInstance | None:
        instances = getattr(self, "_instances", None)
        if instances is None:
            return None
        try:
            if instance_id:
                instances.validate_workspace(workspace)
                return instances.by_id(instance_id)
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
