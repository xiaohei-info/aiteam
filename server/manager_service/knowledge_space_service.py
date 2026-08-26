"""知识空间/绑定业务编排（M3，04 §6.1.2/§6.6；05 F08；D21）。

编排三个 repository（均为租户隔离）：
- KnowledgeSpaceRepository：知识空间 CRUD（rag_workspace 表，workspace 由 ManagerRagService 派生）。
- KnowledgeSpaceBindingRepository：知识空间 → 部门/成员 绑定（仅元数据，不做检索执行）。
- ExpertKnowledgeBinding：专家 → 知识空间 绑定（真相态 = employee_knowledge_binding）。

红线（D21）：
- workspace 只由 ManagerRagService.derive_workspace 推导，业务层不接受/不回显外部直传 workspace。
  出参 KnowledgeSpaceOut.workspace 仅展示派生结果（审计/调试用），不入参。
- 不暴露 LightRAG Server，不做检索执行（归用户端本地）。
- tenant_id 全程经 TenantContext（D22），不手写过滤。
"""

from __future__ import annotations

from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.db import ManagerRagService, PgTenantRouter
from shared.errors import Conflict, Forbidden, NotFound, ValidationProblem

from .knowledge_space_repository import (
    BINDING_RESOURCE_TYPES,
    ExpertKnowledgeBinding,
    KnowledgeSpaceBindingRepository,
    KnowledgeSpaceRepository,
)
from .rag_instances import RagInstanceRegistry
from .schemas import (
    KnowledgeSpaceBindingCreate,
    KnowledgeSpaceBindingOut,
    KnowledgeSpaceCreate,
    KnowledgeSpaceOut,
    KnowledgeSpaceUpdate,
)

# 知识空间写操作允许的企业角色（03 §9.7）。Member 只读。
_KS_WRITE_ROLES = [
    EnterpriseRole.OWNER.value,
    EnterpriseRole.ENTERPRISE_ADMIN.value,
]


class KnowledgeSpaceService:
    """知识空间管理面编排。tenant_id 全程经 TenantContext，不手写过滤（D22）。"""

    def __init__(
        self,
        *,
        repo: KnowledgeSpaceRepository,
        binding_repo: KnowledgeSpaceBindingRepository,
        expert_binding: ExpertKnowledgeBinding,
        instance_registry: RagInstanceRegistry | None = None,
    ):
        self._repo = repo
        self._binding_repo = binding_repo
        self._expert_binding = expert_binding
        self._instance_registry = instance_registry

    # ---- 知识空间 CRUD ----
    def create(self, ctx: TenantContext, body: KnowledgeSpaceCreate) -> KnowledgeSpaceOut:
        _ensure_can_write(ctx)
        if self._repo.get(ctx, knowledge_space_id=body.knowledge_space_id) is not None:
            raise Conflict("knowledge space already exists in this tenant")
        workspace = ManagerRagService.derive_workspace(ctx.tenant_id, body.knowledge_space_id)
        if self._instance_registry is not None:
            try:
                self._instance_registry.resolve(workspace)
            except ValueError as exc:
                raise Conflict("knowledge space has no configured LightRAG instance") from exc
        row = self._repo.create(
            ctx,
            knowledge_space_id=body.knowledge_space_id,
            display_name=body.display_name,
        )
        return _to_space_out(row)

    def get(self, ctx: TenantContext, *, knowledge_space_id: str) -> KnowledgeSpaceOut:
        row = self._require(ctx, knowledge_space_id)
        return _to_space_out(row)

    def list_all(self, ctx: TenantContext) -> list[KnowledgeSpaceOut]:
        return [_to_space_out(r) for r in self._repo.list_all(ctx)]

    def update(
        self, ctx: TenantContext, knowledge_space_id: str, body: KnowledgeSpaceUpdate
    ) -> KnowledgeSpaceOut:
        _ensure_can_write(ctx)
        if self._require(ctx, knowledge_space_id) is None:
            raise NotFound("knowledge space not found in this tenant")
        row = self._repo.update(
            ctx, knowledge_space_id=knowledge_space_id, display_name=body.display_name
        )
        if row is None:  # 双保险：RLS 下跨 tenant 不可见
            raise NotFound("knowledge space not found in this tenant")
        return _to_space_out(row)

    def delete(self, ctx: TenantContext, *, knowledge_space_id: str) -> None:
        _ensure_can_write(ctx)
        # 删知识空间时清残绑定（部门/成员绑定表 + 专家 knowledge_refs 引用）。
        if not self._repo.delete(ctx, knowledge_space_id=knowledge_space_id):
            raise NotFound("knowledge space not found in this tenant")
        self._binding_repo.delete_by_space(ctx, knowledge_space_id=knowledge_space_id)
        self._clear_expert_refs(ctx, knowledge_space_id)

    def _clear_expert_refs(self, ctx: TenantContext, knowledge_space_id: str) -> None:
        """删除知识空间后，禁用所有 employee_knowledge_binding 引用（保持真相态一致）。"""
        for emp_id in self._expert_binding.list_experts_by_space(
            ctx, knowledge_space_id=knowledge_space_id
        ):
            self._expert_binding.unbind(ctx, employee_id=emp_id, knowledge_space_id=knowledge_space_id)

    def _require(self, ctx: TenantContext, knowledge_space_id: str):
        row = self._repo.get(ctx, knowledge_space_id=knowledge_space_id)
        if row is None:
            raise NotFound("knowledge space not found in this tenant")
        return row

    # ---- 绑定 ----
    def bind(self, ctx: TenantContext, body: KnowledgeSpaceBindingCreate) -> KnowledgeSpaceBindingOut:
        _ensure_can_write(ctx)
        # 目标知识空间必须存在（跨 tenant 行 RLS 不可见 → NotFound）。
        if self._repo.get(ctx, knowledge_space_id=body.knowledge_space_id) is None:
            raise NotFound("knowledge space not found in this tenant")
        if body.resource_type == "expert":
            return self._bind_expert(ctx, body)
        return self._bind_dept_member(ctx, body)

    def _bind_expert(
        self, ctx: TenantContext, body: KnowledgeSpaceBindingCreate
    ) -> KnowledgeSpaceBindingOut:
        """专家绑定真相态 = employee_knowledge_binding（供 M7 快照消费）。"""
        if not self._expert_binding.bind(
            ctx, employee_id=body.resource_id, knowledge_space_id=body.knowledge_space_id
        ):
            raise NotFound("employee not found in this tenant")
        # 绑定元数据视图：从 knowledge_refs 派生（不落 knowledge_space_binding 表）。
        return KnowledgeSpaceBindingOut(
            id=f"expert:{body.resource_id}:{body.knowledge_space_id}",
            tenant_id=ctx.tenant_id,
            knowledge_space_id=body.knowledge_space_id,
            resource_type="expert",
            resource_id=body.resource_id,
            created_at=None,
        )

    def _bind_dept_member(
        self, ctx: TenantContext, body: KnowledgeSpaceBindingCreate
    ) -> KnowledgeSpaceBindingOut:
        row = self._binding_repo.upsert(
            ctx,
            knowledge_space_id=body.knowledge_space_id,
            resource_type=body.resource_type,
            resource_id=body.resource_id,
        )
        return _to_binding_out(row, tenant_id=ctx.tenant_id)

    def list_bindings(
        self, ctx: TenantContext, *, knowledge_space_id: str
    ) -> list[KnowledgeSpaceBindingOut]:
        if self._repo.get(ctx, knowledge_space_id=knowledge_space_id) is None:
            raise NotFound("knowledge space not found in this tenant")
        out: list[KnowledgeSpaceBindingOut] = []
        # 部门/成员绑定（knowledge_space_binding 表）。
        for r in self._binding_repo.list_by_space(ctx, knowledge_space_id=knowledge_space_id):
            out.append(_to_binding_out(r, tenant_id=ctx.tenant_id))
        # 专家绑定（从 employee_knowledge_binding 派生）。
        for emp_id in self._expert_binding.list_experts_by_space(
            ctx, knowledge_space_id=knowledge_space_id
        ):
            out.append(
                KnowledgeSpaceBindingOut(
                    id=f"expert:{emp_id}:{knowledge_space_id}",
                    tenant_id=ctx.tenant_id,
                    knowledge_space_id=knowledge_space_id,
                    resource_type="expert",
                    resource_id=emp_id,
                    created_at=None,
                )
            )
        return out

    def unbind(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        resource_type: str,
        resource_id: str,
    ) -> None:
        _ensure_can_write(ctx)
        if resource_type == "expert":
            self._expert_binding.unbind(
                ctx, employee_id=resource_id, knowledge_space_id=knowledge_space_id
            )
            return
        self._binding_repo.delete_one(
            ctx,
            knowledge_space_id=knowledge_space_id,
            resource_type=resource_type,
            resource_id=resource_id,
        )


def _ensure_can_write(ctx: TenantContext) -> None:
    """知识空间写操作鉴权（03 §9.7）。非 owner/enterprise_admin → 403。"""
    if not set(ctx.roles) & set(_KS_WRITE_ROLES):
        raise Forbidden("knowledge space write requires owner or enterprise_admin")


def _validate_binding_resource_type(resource_type: str) -> None:
    """绑定目标白名单（expert|department|member）。

    expert 走 employee_knowledge_binding；department/member 走 knowledge_space_binding 表。
    抛 ValidationProblem（422），schema 层 Literal 双保险。
    """
    if resource_type not in ("expert",) + BINDING_RESOURCE_TYPES:
        raise ValidationProblem(
            detail=f"resource_type must be one of expert|department|member, got: {resource_type!r}",
            errors=None,
        )


def _to_space_out(row) -> KnowledgeSpaceOut:
    return KnowledgeSpaceOut(
        knowledge_space_id=row.knowledge_space_id,
        workspace=row.workspace,
        display_name=row.display_name,
        created_at=row.created_at,
    )


def _to_binding_out(row, *, tenant_id: str) -> KnowledgeSpaceBindingOut:
    return KnowledgeSpaceBindingOut(
        id=row.id,
        tenant_id=tenant_id,
        knowledge_space_id=row.knowledge_space_id,
        resource_type=row.resource_type,
        resource_id=row.resource_id,
        created_at=row.created_at,
    )


def build_knowledge_space_service(
    router: PgTenantRouter, instance_registry: RagInstanceRegistry | None = None,
) -> KnowledgeSpaceService:
    """组装知识空间服务（业务连接 app_rw，#60）。三个 repository 共享同一 router。"""
    return KnowledgeSpaceService(
        repo=KnowledgeSpaceRepository(router),
        binding_repo=KnowledgeSpaceBindingRepository(router),
        expert_binding=ExpertKnowledgeBinding(router),
        instance_registry=instance_registry,
    )


__all__ = [
    "KnowledgeSpaceService",
    "build_knowledge_space_service",
]
