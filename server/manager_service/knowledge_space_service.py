"""Enterprise knowledge compatibility mapping orchestration (M3, D21).

The visible product is one enterprise knowledge base per tenant; a Manager
process may serve multiple tenants, with each request isolated by TenantContext.
`rag_workspace`/binding rows remain internal compatibility metadata for existing
citations and projections; raw LightRAG workspaces are never accepted from HTTP.
"""

from __future__ import annotations

from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict, Forbidden, NotFound, ValidationProblem

from .knowledge_space_repository import (
    BINDING_RESOURCE_TYPES,
    ExpertKnowledgeBinding,
    KnowledgeSpaceBindingRepository,
    KnowledgeSpaceRepository,
    KnowledgeSpaceRow,
)
from .rag import enterprise_knowledge_space_id
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
        enterprise_only: bool = False,
    ):
        self._repo = repo
        self._binding_repo = binding_repo
        self._expert_binding = expert_binding
        self._enterprise_only = enterprise_only

    # ---- 知识空间 CRUD ----
    def create(self, ctx: TenantContext, body: KnowledgeSpaceCreate) -> KnowledgeSpaceOut:
        _ensure_can_write(ctx)
        if self._repo.get(ctx, knowledge_space_id=body.knowledge_space_id) is not None:
            raise Conflict("knowledge space already exists in this tenant")
        enterprise_checker = getattr(self._repo, "is_enterprise_space", None)
        if self._enterprise_only and callable(enterprise_checker) and any(
            enterprise_checker(ctx, knowledge_space_id=row.knowledge_space_id)
            for row in self._repo.list_all(ctx)
        ):
            raise Conflict("knowledge space already exists in this tenant")
        if self._enterprise_only and body.knowledge_space_id != enterprise_knowledge_space_id():
            raise Conflict("Manager exposes one enterprise knowledge base")
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
        if self._enterprise_only:
            ensured = self._repo.ensure(
                ctx, knowledge_space_id=enterprise_knowledge_space_id(), display_name="企业知识库",
            )
            return [_to_space_out(ensured)]
        return [_to_space_out(r) for r in self._repo.list_all(ctx)]

    def update(
        self, ctx: TenantContext, knowledge_space_id: str, body: KnowledgeSpaceUpdate
    ) -> KnowledgeSpaceOut:
        _ensure_can_write(ctx)
        if self._enterprise_only and not self._is_enterprise_key(ctx, knowledge_space_id):
            raise Conflict("Manager exposes one enterprise knowledge base")
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
        if self._enterprise_only:
            raise Conflict("enterprise knowledge base cannot be deleted")
        # Legacy rows retain their controlled cleanup path for compatibility in
        # non-production embedding callers; Manager routes expose only the
        # canonical enterprise key.
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

    def _is_enterprise_key(self, ctx: TenantContext, knowledge_space_id: str) -> bool:
        checker = getattr(self._repo, "is_enterprise_space", None)
        return bool(checker and checker(ctx, knowledge_space_id=knowledge_space_id))

    def _require(self, ctx: TenantContext, knowledge_space_id: str):
        row = self._repo.get(ctx, knowledge_space_id=knowledge_space_id)
        if row is None:
            raise NotFound("knowledge space not found in this tenant")
        return row

    # ---- 绑定 ----
    def bind(self, ctx: TenantContext, body: KnowledgeSpaceBindingCreate) -> KnowledgeSpaceBindingOut:
        _ensure_can_write(ctx)
        if self._enterprise_only and not self._is_enterprise_key(ctx, body.knowledge_space_id):
            raise Conflict("Manager exposes one enterprise knowledge base")
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
        if self._enterprise_only and not self._is_enterprise_key(ctx, knowledge_space_id):
            raise Conflict("Manager exposes one enterprise knowledge base")
        if resource_type == "expert":
            removed = self._expert_binding.unbind(
                ctx, employee_id=resource_id, knowledge_space_id=knowledge_space_id
            )
            if removed is False:
                raise NotFound("employee not found in this tenant")
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


def ensure_enterprise_knowledge_space(
    dsn: str,
    tenant_id: str,
    *,
    instance_registry=None,
) -> KnowledgeSpaceRow:
    """Idempotently provision the tenant-owned enterprise space."""
    repo = KnowledgeSpaceRepository(PgTenantRouter(dsn), instance_registry=instance_registry)
    ctx = TenantContext(tenant_id=tenant_id, user_id="manager-system", roles=["service"])
    return repo.ensure(
        ctx,
        knowledge_space_id=enterprise_knowledge_space_id(),
        display_name="企业知识库",
    )


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
    router: PgTenantRouter,
    *,
    instance_registry=None,
) -> KnowledgeSpaceService:
    """组装每 tenant 唯一知识空间服务（业务连接 app_rw，#60）。"""
    return KnowledgeSpaceService(
        repo=KnowledgeSpaceRepository(router, instance_registry=instance_registry),
        binding_repo=KnowledgeSpaceBindingRepository(router),
        expert_binding=ExpertKnowledgeBinding(router),
        enterprise_only=True,
    )


__all__ = [
    "KnowledgeSpaceService",
    "build_knowledge_space_service",
]
