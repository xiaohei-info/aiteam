"""Enterprise knowledge compatibility routes (M3, 02 §10.1/§10.3 + 04 §6.1.2/6.6 + 05 F08; D21).

The `/knowledge-spaces/*` path is retained for existing Agent/document/citation
keys; the Manager UI exposes only the one enterprise knowledge base. Protected
writes require owner/enterprise_admin.
统一 envelope（02 §10.3.4）+ problem+json（02 §11.2）。tenant_id 经 TenantContext（D22）。

红线（D21）：
- workspace 只由 ManagerRagService 从 ctx 推导，HTTP 入参不接受 workspace（schema 无该字段）。
- 不暴露 LightRAG Server，不做检索执行（归用户端本地，F12）。

verifier 注入：本端 DevTokenService（骨架期）/ 生产 RS256 验签器由 app 持有，经 build_knowledge_space_router
闭包注入各端点依赖，避免依赖 app.state 时序。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import Response

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .knowledge_space_service import KnowledgeSpaceService, build_knowledge_space_service
from .rag_instances import RagInstanceRegistry
from .schemas import (
    KnowledgeSpaceBindingCreate,
    KnowledgeSpaceBindingOut,
    KnowledgeSpaceCreate,
    KnowledgeSpaceOut,
    KnowledgeSpaceUpdate,
)


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> KnowledgeSpaceService:
    """从端配置构造 KnowledgeSpaceService；未配置业务 DB → 503（不静默，与 employee/auth 路由一致）。"""
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_knowledge_space_service", None)
    if cache is None:
        registry = RagInstanceRegistry.from_env()
        enterprise_workspace = registry.instances[0].workspace if registry is not None else "enterprise_shared"
        cache = build_knowledge_space_service(
            PgTenantRouter(dsn), registry, enterprise_workspace,
        )
        request.app.state._knowledge_space_service = cache
    return cache


def build_knowledge_space_router(verifier) -> APIRouter:
    """构造知识空间管理面路由；verifier 由 app 持有并闭包注入受保护端点。"""
    router = APIRouter(
        prefix="/api/manager/knowledge-spaces", tags=["manager", "knowledge-space"]
    )
    require = require_claims(verifier)

    @router.post(
        "", description="请查看接口名称了解用途", summary="建知识空间（workspace 由 ManagerRagService 推导，D21）",
        operation_id="manager_knowledge_space_create", status_code=status.HTTP_201_CREATED,
    )
    async def create_knowledge_space(
        body: KnowledgeSpaceCreate,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeSpaceOut]:
        svc = _service(request)
        out = svc.create(tenant_context_from(claims), body)
        return Envelope[KnowledgeSpaceOut](data=out)

    @router.get(
        "", description="请查看接口名称了解用途", summary="列本租户全部知识空间",
        operation_id="manager_knowledge_space_list",
    )
    async def list_knowledge_space(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[KnowledgeSpaceOut]:
        svc = _service(request)
        items = svc.list_all(tenant_context_from(claims))
        return ListEnvelope[KnowledgeSpaceOut](data=items)

    @router.get(
        "/{knowledge_space_id}", description="请查看接口名称了解用途", summary="取单个知识空间",
        operation_id="manager_knowledge_space_get",
    )
    async def get_knowledge_space(
        knowledge_space_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeSpaceOut]:
        svc = _service(request)
        return Envelope[KnowledgeSpaceOut](
            data=svc.get(tenant_context_from(claims), knowledge_space_id=knowledge_space_id)
        )

    @router.patch(
        "/{knowledge_space_id}", description="请查看接口名称了解用途", summary="改知识空间展示名",
        operation_id="manager_knowledge_space_update",
    )
    async def update_knowledge_space(
        knowledge_space_id: str,
        body: KnowledgeSpaceUpdate,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeSpaceOut]:
        svc = _service(request)
        return Envelope[KnowledgeSpaceOut](
            data=svc.update(tenant_context_from(claims), knowledge_space_id, body)
        )

    @router.delete(
        "/{knowledge_space_id}", description="请查看接口名称了解用途", summary="删知识空间（清残绑定）",
        operation_id="manager_knowledge_space_delete",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    async def delete_knowledge_space(
        knowledge_space_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        svc = _service(request)
        svc.delete(tenant_context_from(claims), knowledge_space_id=knowledge_space_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # ---- 绑定（专家走 employee_knowledge_binding；部门/成员走 knowledge_space_binding 表）----

    @router.post(
        "/{knowledge_space_id}/bindings",
        description="请查看接口名称了解用途", summary="绑定知识空间到 专家/部门/成员（仅元数据，不检索，D21）",
        operation_id="manager_knowledge_space_bind",
        status_code=status.HTTP_201_CREATED,
    )
    async def bind_resource(
        knowledge_space_id: str,
        body: KnowledgeSpaceBindingCreate,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeSpaceBindingOut]:
        svc = _service(request)
        # 路径与体一致：以路径为准（避免不一致注入）。
        body = body.model_copy(update={"knowledge_space_id": knowledge_space_id})
        return Envelope[KnowledgeSpaceBindingOut](
            data=svc.bind(tenant_context_from(claims), body)
        )

    @router.get(
        "/{knowledge_space_id}/bindings",
        description="请查看接口名称了解用途", summary="列知识空间的全部绑定（专家派生自 knowledge_refs + 部门/成员表）",
        operation_id="manager_knowledge_space_list_bindings",
    )
    async def list_bindings(
        knowledge_space_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[KnowledgeSpaceBindingOut]:
        svc = _service(request)
        items = svc.list_bindings(
            tenant_context_from(claims), knowledge_space_id=knowledge_space_id
        )
        return ListEnvelope[KnowledgeSpaceBindingOut](data=items)

    @router.delete(
        "/{knowledge_space_id}/bindings/{resource_type}/{resource_id}",
        description="请查看接口名称了解用途", summary="解绑",
        operation_id="manager_knowledge_space_unbind",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    async def unbind_resource(
        knowledge_space_id: str,
        resource_type: str,
        resource_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        svc = _service(request)
        svc.unbind(
            tenant_context_from(claims),
            knowledge_space_id=knowledge_space_id,
            resource_type=resource_type,
            resource_id=resource_id,
        )
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router
