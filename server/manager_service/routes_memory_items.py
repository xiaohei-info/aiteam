"""Manager 企业端记忆条目管理路由（B07 记忆管理）。

边界：Manager 管理员工记忆条目（CRUD/搜索/批量删除/按员工查看）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, status
from fastapi.responses import Response

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .memory_items_repository import MemoryItemsRepository
from .memory_items_service import MemoryItemsService
from .routes_memory_schemas import (
    MemoryBulkDelete,
    MemoryItemCreate,
    MemoryItemOut,
    MemoryItemPatch,
)


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> MemoryItemsService:
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_memory_items_service", None)
    if cache is None:
        cache = MemoryItemsService(MemoryItemsRepository(PgTenantRouter(dsn)))
        request.app.state._memory_items_service = cache
    return cache


def build_memory_items_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/memories", tags=["manager", "memory-items"])
    require = require_claims(verifier)

    @router.get("", summary="列出记忆条目", operation_id="manager_memory_list")
    async def list_memories(
        request: Request,
        employee_id: str | None = Query(default=None),
        keyword: str | None = Query(default=None),
        category: str | None = Query(default=None),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[MemoryItemOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        items = svc.list_memories(ctx, employee_id=employee_id, keyword=keyword, category=category)
        return ListEnvelope(data=[MemoryItemOut(**r) for r in items])

    @router.post("", summary="新增记忆条目", operation_id="manager_memory_create")
    async def create_memory(
        body: MemoryItemCreate,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[MemoryItemOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.create_memory(
            ctx, employee_id=body.employee_id, content=body.content,
            category=body.category, importance=body.importance,
        )
        return Envelope(data=MemoryItemOut(**data))

    @router.patch("/{memory_id}", summary="编辑记忆条目", operation_id="manager_memory_patch")
    async def patch_memory(
        memory_id: str,
        body: MemoryItemPatch,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[MemoryItemOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.patch_memory(
            ctx, memory_id, content=body.content, category=body.category, importance=body.importance,
        )
        return Envelope(data=MemoryItemOut(**data))

    @router.delete("/{memory_id}", summary="删除记忆条目", operation_id="manager_memory_delete",
                status_code=status.HTTP_204_NO_CONTENT)
    async def delete_memory(
        memory_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        svc.delete_memory(ctx, memory_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post("/bulk-delete", summary="批量删除记忆条目", operation_id="manager_memory_bulk_delete")
    async def bulk_delete(
        body: MemoryBulkDelete,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> dict:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        count = svc.bulk_delete(ctx, body.memory_ids)
        return {"deleted_count": count}

    return router
