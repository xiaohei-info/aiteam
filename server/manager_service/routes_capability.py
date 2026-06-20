"""技能/连接器/记忆策略 目录北向路由（M4，02 §10.1/§10.3 + 04 §6.6，D17/D16/D22）。

路径：/api/manager/skills|connectors|memory-policies/*。受保护端点（require_claims）；
目录写操作需 owner/enterprise_admin（03 §9.7）。统一 envelope（02 §10.3.4）+ problem+json（02 §11.2）。
tenant_id 经 TenantContext（D22）。

红线（issue #38）：仅管理面真相 CRUD，不实现执行（技能执行/连接器对外调用/记忆读写归用户端）。

verifier 注入：照 build_employee_router 模式，由 app 闭包注入避免依赖 app.state 时序。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import Response

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .capability_catalog_service import CapabilityCatalogService, build_capability_catalog_service
from .schemas import (
    ConnectorCatalogIn,
    ConnectorCatalogOut,
    MemoryPolicyCatalogIn,
    MemoryPolicyCatalogOut,
    SkillCatalogIn,
    SkillCatalogOut,
)


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> CapabilityCatalogService:
    """从端配置构造 CapabilityCatalogService；未配置业务 DB → 503（不静默，与 employee 路由一致）。"""
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_capability_catalog_service", None)
    if cache is None:
        cache = build_capability_catalog_service(PgTenantRouter(dsn))
        request.app.state._capability_catalog_service = cache
    return cache


def build_capability_router(verifier) -> APIRouter:
    """构造能力目录三组路由；verifier 由 app 持有并闭包注入受保护端点。"""
    router = APIRouter(prefix="/api/manager", tags=["manager", "capability-catalog"])
    require = require_claims(verifier)

    # ---- skill 目录（/api/manager/skills/*）----

    @router.post(
        "/skills", summary="建技能目录条目（runtime 中立，D16）",
        operation_id="manager_skill_catalog_create", status_code=status.HTTP_201_CREATED,
    )
    async def create_skill(
        body: SkillCatalogIn, request: Request, claims: TokenClaims = Depends(require),
    ) -> Envelope[SkillCatalogOut]:
        svc = _service(request)
        return Envelope[SkillCatalogOut](data=svc.create_skill(tenant_context_from(claims), body))

    @router.get("/skills", summary="列本租户技能目录", operation_id="manager_skill_catalog_list")
    async def list_skills(
        request: Request, claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[SkillCatalogOut]:
        svc = _service(request)
        return ListEnvelope[SkillCatalogOut](data=svc.list_skills(tenant_context_from(claims)))

    @router.get("/skills/{catalog_id}", summary="取单个技能目录条目", operation_id="manager_skill_catalog_get")
    async def get_skill(
        catalog_id: str, request: Request, claims: TokenClaims = Depends(require),
    ) -> Envelope[SkillCatalogOut]:
        svc = _service(request)
        return Envelope[SkillCatalogOut](
            data=svc.get_skill(tenant_context_from(claims), catalog_id=catalog_id)
        )

    @router.put(
        "/skills/{catalog_id}", summary="改写技能目录条目（catalog_version 自增）",
        operation_id="manager_skill_catalog_update",
    )
    async def update_skill(
        catalog_id: str, body: SkillCatalogIn, request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[SkillCatalogOut]:
        svc = _service(request)
        return Envelope[SkillCatalogOut](
            data=svc.update_skill(tenant_context_from(claims), body, catalog_id=catalog_id)
        )

    @router.delete(
        "/skills/{catalog_id}", summary="删技能目录条目",
        operation_id="manager_skill_catalog_delete", status_code=status.HTTP_204_NO_CONTENT,
    )
    async def delete_skill(
        catalog_id: str, request: Request, claims: TokenClaims = Depends(require),
    ) -> Response:
        svc = _service(request)
        svc.delete_skill(tenant_context_from(claims), catalog_id=catalog_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # ---- connector 目录（/api/manager/connectors/*）----

    @router.post(
        "/connectors", summary="建连接器目录条目（凭据本体归 M5，D18）",
        operation_id="manager_connector_catalog_create", status_code=status.HTTP_201_CREATED,
    )
    async def create_connector(
        body: ConnectorCatalogIn, request: Request, claims: TokenClaims = Depends(require),
    ) -> Envelope[ConnectorCatalogOut]:
        svc = _service(request)
        return Envelope[ConnectorCatalogOut](
            data=svc.create_connector(tenant_context_from(claims), body)
        )

    @router.get("/connectors", summary="列本租户连接器目录", operation_id="manager_connector_catalog_list")
    async def list_connectors(
        request: Request, claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[ConnectorCatalogOut]:
        svc = _service(request)
        return ListEnvelope[ConnectorCatalogOut](data=svc.list_connectors(tenant_context_from(claims)))

    @router.get(
        "/connectors/{catalog_id}", summary="取单个连接器目录条目",
        operation_id="manager_connector_catalog_get",
    )
    async def get_connector(
        catalog_id: str, request: Request, claims: TokenClaims = Depends(require),
    ) -> Envelope[ConnectorCatalogOut]:
        svc = _service(request)
        return Envelope[ConnectorCatalogOut](
            data=svc.get_connector(tenant_context_from(claims), catalog_id=catalog_id)
        )

    @router.put(
        "/connectors/{catalog_id}", summary="改写连接器目录条目（catalog_version 自增）",
        operation_id="manager_connector_catalog_update",
    )
    async def update_connector(
        catalog_id: str, body: ConnectorCatalogIn, request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[ConnectorCatalogOut]:
        svc = _service(request)
        return Envelope[ConnectorCatalogOut](
            data=svc.update_connector(tenant_context_from(claims), body, catalog_id=catalog_id)
        )

    @router.delete(
        "/connectors/{catalog_id}", summary="删连接器目录条目",
        operation_id="manager_connector_catalog_delete", status_code=status.HTTP_204_NO_CONTENT,
    )
    async def delete_connector(
        catalog_id: str, request: Request, claims: TokenClaims = Depends(require),
    ) -> Response:
        svc = _service(request)
        svc.delete_connector(tenant_context_from(claims), catalog_id=catalog_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # ---- memory_policy 目录（/api/manager/memory-policies/*，D17）----

    @router.post(
        "/memory-policies", summary="建记忆策略目录条目（复用 mem0，D17）",
        operation_id="manager_memory_policy_catalog_create", status_code=status.HTTP_201_CREATED,
    )
    async def create_memory_policy(
        body: MemoryPolicyCatalogIn, request: Request, claims: TokenClaims = Depends(require),
    ) -> Envelope[MemoryPolicyCatalogOut]:
        svc = _service(request)
        return Envelope[MemoryPolicyCatalogOut](
            data=svc.create_memory_policy(tenant_context_from(claims), body)
        )

    @router.get(
        "/memory-policies", summary="列本租户记忆策略目录",
        operation_id="manager_memory_policy_catalog_list",
    )
    async def list_memory_policies(
        request: Request, claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[MemoryPolicyCatalogOut]:
        svc = _service(request)
        return ListEnvelope[MemoryPolicyCatalogOut](
            data=svc.list_memory_policies(tenant_context_from(claims))
        )

    @router.get(
        "/memory-policies/{catalog_id}", summary="取单个记忆策略目录条目",
        operation_id="manager_memory_policy_catalog_get",
    )
    async def get_memory_policy(
        catalog_id: str, request: Request, claims: TokenClaims = Depends(require),
    ) -> Envelope[MemoryPolicyCatalogOut]:
        svc = _service(request)
        return Envelope[MemoryPolicyCatalogOut](
            data=svc.get_memory_policy(tenant_context_from(claims), catalog_id=catalog_id)
        )

    @router.put(
        "/memory-policies/{catalog_id}", summary="改写记忆策略目录条目（catalog_version 自增）",
        operation_id="manager_memory_policy_catalog_update",
    )
    async def update_memory_policy(
        catalog_id: str, body: MemoryPolicyCatalogIn, request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[MemoryPolicyCatalogOut]:
        svc = _service(request)
        return Envelope[MemoryPolicyCatalogOut](
            data=svc.update_memory_policy(tenant_context_from(claims), body, catalog_id=catalog_id)
        )

    @router.delete(
        "/memory-policies/{catalog_id}", summary="删记忆策略目录条目",
        operation_id="manager_memory_policy_catalog_delete", status_code=status.HTTP_204_NO_CONTENT,
    )
    async def delete_memory_policy(
        catalog_id: str, request: Request, claims: TokenClaims = Depends(require),
    ) -> Response:
        svc = _service(request)
        svc.delete_memory_policy(tenant_context_from(claims), catalog_id=catalog_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router
