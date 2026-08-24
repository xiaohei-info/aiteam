"""技能/连接器/记忆策略 目录业务编排（M4，04 §6.6，D17/D16/D22）。

编排 repository（租户隔离）+ 冲突/缺失判定。runtime 中立（D16）：只搬运中立字段，
不含 runtime 原生格式。记忆策略复用 mem0（OpenMemory，D17），本卡只落策略真相。

红线（issue #38）：① 仅管理面真相，执行在用户端本地；② 不绕 tenant；③ 不发起连接器对外
调用/技能执行（本卡只 CRUD 管理面真相）。
"""

from __future__ import annotations

from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict, Forbidden, NotFound

from .capability_catalog_repository import (
    CapabilityCatalogRepository,
    ConnectorCatalogRow,
    MemoryPolicyCatalogRow,
    SkillCatalogRow,
)
from .schemas import (
    ConnectorCatalogIn,
    ConnectorCatalogOut,
    MemoryPolicyCatalogIn,
    MemoryPolicyCatalogOut,
    SkillCatalogIn,
    SkillCatalogOut,
    SkillFileIn,
)

# 目录写操作允许的企业角色（03 §9.7）。Member 只读（由 routes 层 authorize 强制）。
_CATALOG_WRITE_ROLES = [
    EnterpriseRole.OWNER.value,
    EnterpriseRole.ENTERPRISE_ADMIN.value,
]


class CapabilityCatalogService:
    """能力目录 CRUD 编排。tenant_id 全程经 TenantContext，不手写过滤（D22）。"""

    def __init__(self, repo: CapabilityCatalogRepository):
        self._repo = repo

    # ---- skill ----

    def create_skill(self, ctx: TenantContext, body: SkillCatalogIn) -> SkillCatalogOut:
        _ensure_can_write(ctx)
        if body.skill_id.startswith("platform-"):
            raise Conflict("platform skill IDs are reserved for Operator-managed installs")
        if self._repo.get_skill_by_id(ctx, skill_id=body.skill_id) is not None:
            raise Conflict("skill_id already exists in this tenant")
        row = self._repo.create_skill(
            ctx, skill_id=body.skill_id, display_name=body.display_name, version=body.version,
            install_policy=body.install_policy, binding_policy=body.binding_policy,
            visibility=body.visibility, config=body.config,
            files=[f.model_dump(mode="json") for f in body.files], content_hash=body.content_hash,
        )
        return _skill_to_out(row)

    def get_skill(self, ctx: TenantContext, *, catalog_id: str) -> SkillCatalogOut:
        return _skill_to_out(self._require_skill(ctx, catalog_id))

    def update_skill(self, ctx: TenantContext, body: SkillCatalogIn, *, catalog_id: str) -> SkillCatalogOut:
        _ensure_can_write(ctx)
        current = self._require_skill(ctx, catalog_id)
        if current.config.get("source") == "operator":
            raise Conflict("Operator-managed skills are immutable; update through the platform skill market")
        # skill_id 不可变（unique 约束的稳定标识）；其余字段以 body 覆盖。
        row = self._repo.update_skill(
            ctx, catalog_id=catalog_id, display_name=body.display_name, version=body.version,
            install_policy=body.install_policy, binding_policy=body.binding_policy,
            visibility=body.visibility, config=body.config,
            files=[f.model_dump(mode="json") for f in body.files],
            content_hash=body.content_hash,
        )
        if row is None:  # 双保险：RLS 下跨 tenant 不可见
            raise NotFound("skill not found in this tenant")
        return _skill_to_out(row)

    def delete_skill(self, ctx: TenantContext, *, catalog_id: str) -> None:
        _ensure_can_write(ctx)
        current = self._require_skill(ctx, catalog_id)
        if current.config.get("source") == "operator":
            raise Conflict("Operator-managed skills are immutable; uninstall through the platform skill market")
        if not self._repo.delete(ctx, resource_kind="skill", catalog_id=catalog_id):
            raise NotFound("skill not found in this tenant")

    def list_skills(self, ctx: TenantContext) -> list[SkillCatalogOut]:
        return [_skill_to_out(r) for r in self._repo.list_skills(ctx)]

    def _require_skill(self, ctx: TenantContext, catalog_id: str) -> SkillCatalogRow:
        row = self._repo.get_skill(ctx, catalog_id=catalog_id)
        if row is None:
            raise NotFound("skill not found in this tenant")
        return row

    # ---- connector ----

    def create_connector(self, ctx: TenantContext, body: ConnectorCatalogIn) -> ConnectorCatalogOut:
        _ensure_can_write(ctx)
        if self._repo.get_connector_by_id(ctx, connector_id=body.connector_id) is not None:
            raise Conflict("connector_id already exists in this tenant")
        row = self._repo.create_connector(
            ctx, connector_id=body.connector_id, display_name=body.display_name,
            visibility=body.visibility, grant_scope=body.grant_scope, config=body.config,
        )
        return _connector_to_out(row)

    def get_connector(self, ctx: TenantContext, *, catalog_id: str) -> ConnectorCatalogOut:
        return _connector_to_out(self._require_connector(ctx, catalog_id))

    def update_connector(self, ctx: TenantContext, body: ConnectorCatalogIn, *, catalog_id: str) -> ConnectorCatalogOut:
        _ensure_can_write(ctx)
        if self._repo.get_connector(ctx, catalog_id=catalog_id) is None:
            raise NotFound("connector not found in this tenant")
        row = self._repo.update_connector(
            ctx, catalog_id=catalog_id, display_name=body.display_name, visibility=body.visibility,
            grant_scope=body.grant_scope, config=body.config,
        )
        if row is None:
            raise NotFound("connector not found in this tenant")
        return _connector_to_out(row)

    def delete_connector(self, ctx: TenantContext, *, catalog_id: str) -> None:
        _ensure_can_write(ctx)
        if not self._repo.delete(ctx, resource_kind="connector", catalog_id=catalog_id):
            raise NotFound("connector not found in this tenant")

    def list_connectors(self, ctx: TenantContext) -> list[ConnectorCatalogOut]:
        return [_connector_to_out(r) for r in self._repo.list_connectors(ctx)]

    def _require_connector(self, ctx: TenantContext, catalog_id: str) -> ConnectorCatalogRow:
        row = self._repo.get_connector(ctx, catalog_id=catalog_id)
        if row is None:
            raise NotFound("connector not found in this tenant")
        return row

    # ---- memory_policy ----

    def create_memory_policy(self, ctx: TenantContext, body: MemoryPolicyCatalogIn) -> MemoryPolicyCatalogOut:
        _ensure_can_write(ctx)
        if self._repo.get_memory_policy_by_id(ctx, policy_id=body.policy_id) is not None:
            raise Conflict("policy_id already exists in this tenant")
        row = self._repo.create_memory_policy(
            ctx, policy_id=body.policy_id, display_name=body.display_name, policy=body.policy,
            seed_memories=body.seed_memories, retention_days=body.retention_days,
            visibility=body.visibility, config=body.config,
        )
        return _memory_to_out(row)

    def get_memory_policy(self, ctx: TenantContext, *, catalog_id: str) -> MemoryPolicyCatalogOut:
        return _memory_to_out(self._require_memory_policy(ctx, catalog_id))

    def update_memory_policy(
        self, ctx: TenantContext, body: MemoryPolicyCatalogIn, *, catalog_id: str,
    ) -> MemoryPolicyCatalogOut:
        _ensure_can_write(ctx)
        if self._repo.get_memory_policy(ctx, catalog_id=catalog_id) is None:
            raise NotFound("memory_policy not found in this tenant")
        row = self._repo.update_memory_policy(
            ctx, catalog_id=catalog_id, display_name=body.display_name, policy=body.policy,
            seed_memories=body.seed_memories, retention_days=body.retention_days,
            visibility=body.visibility, config=body.config,
        )
        if row is None:
            raise NotFound("memory_policy not found in this tenant")
        return _memory_to_out(row)

    def delete_memory_policy(self, ctx: TenantContext, *, catalog_id: str) -> None:
        _ensure_can_write(ctx)
        if not self._repo.delete(ctx, resource_kind="memory_policy", catalog_id=catalog_id):
            raise NotFound("memory_policy not found in this tenant")

    def list_memory_policies(self, ctx: TenantContext) -> list[MemoryPolicyCatalogOut]:
        return [_memory_to_out(r) for r in self._repo.list_memory_policies(ctx)]

    def _require_memory_policy(self, ctx: TenantContext, catalog_id: str) -> MemoryPolicyCatalogRow:
        row = self._repo.get_memory_policy(ctx, catalog_id=catalog_id)
        if row is None:
            raise NotFound("memory_policy not found in this tenant")
        return row


def _ensure_can_write(ctx: TenantContext) -> None:
    """目录写操作鉴权（03 §9.7）。非 owner/enterprise_admin → 403。"""
    if not set(ctx.roles) & set(_CATALOG_WRITE_ROLES):
        raise Forbidden("catalog write requires owner or enterprise_admin")


def _skill_to_out(row: SkillCatalogRow) -> SkillCatalogOut:
    files_in = [_to_skill_file_in(f, default_version=row.version) for f in (getattr(row, "files", None) or [])]
    return SkillCatalogOut(
        catalog_id=row.catalog_id, skill_id=row.skill_id, display_name=row.display_name,
        version=row.version, install_policy=row.install_policy, binding_policy=row.binding_policy,
        visibility=row.visibility, config=row.config, files=files_in,
        content_hash=getattr(row, "content_hash", "") or "", catalog_version=row.catalog_version,
    )


def _to_skill_file_in(raw, default_version: str) -> SkillFileIn:
    if isinstance(raw, SkillFileIn):
        return raw
    if isinstance(raw, dict):
        return SkillFileIn(path=str(raw.get("path", "")), content=str(raw.get("content", "")))
    return SkillFileIn(path="", content="")


def _connector_to_out(row: ConnectorCatalogRow) -> ConnectorCatalogOut:
    return ConnectorCatalogOut(
        catalog_id=row.catalog_id, connector_id=row.connector_id, display_name=row.display_name,
        visibility=row.visibility, grant_scope=row.grant_scope, config=row.config,
        catalog_version=row.catalog_version,
    )


def _memory_to_out(row: MemoryPolicyCatalogRow) -> MemoryPolicyCatalogOut:
    return MemoryPolicyCatalogOut(
        catalog_id=row.catalog_id, policy_id=row.policy_id, display_name=row.display_name,
        policy=row.policy, seed_memories=row.seed_memories, retention_days=row.retention_days,
        visibility=row.visibility, config=row.config, catalog_version=row.catalog_version,
    )


def build_capability_catalog_service(router: PgTenantRouter) -> CapabilityCatalogService:
    return CapabilityCatalogService(CapabilityCatalogRepository(router))
