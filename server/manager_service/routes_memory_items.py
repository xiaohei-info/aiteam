"""Authenticated Manager facade over employee-private Hindsight memory.

Manager owns current-enterprise authorization; Hindsight owns memory storage. No
local memory CRUD repository is constructed here.
"""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any

from fastapi import APIRouter, Depends, Header, Query, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .employee_bindings_repositories import EmployeeKnowledgeBindingRepository
from .analytics_schemas import MemoryAnalyticsOut
from .employee_config_repository import EmployeeConfigRepository
from .employee_config_service import build_employee_config_service
from .enterprise_audit_repository import build_enterprise_audit_repository
from .hindsight_client import HindsightClient
from .member_service import GrantService, MemberDeptService
from .memory_service import MemoryService, build_memory_service
from .openapi_schemas import MemoryResultOut
from .repository_member import GrantRepository, MemberDeptRepository
from .snapshot_service import build_snapshot_service


class MemoryRetainIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_id: str = Field(min_length=1)
    content: str = Field(min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict, description="写入 Hindsight 的附加元数据。")


class MemoryUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str | None = Field(default=None, min_length=1)
    content: str | None = Field(default=None, min_length=1)
    state: str | None = Field(default=None, pattern="^(valid|invalidated)$")


class MemoryItemOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    memory_id: str
    employee_id: str
    content: str
    category: str
    importance: float | None = None
    source: str
    created_at: str | None = None
    last_used_at: str | None = None
    state: str = "valid"


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> MemoryService:
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    service = getattr(request.app.state, "_memory_service", None)
    if service is None:
        router = PgTenantRouter(dsn)
        member_repo = MemberDeptRepository(router)
        grant_repo = GrantRepository(router)
        snapshot = build_snapshot_service(
            config_service=build_employee_config_service(router),
            grant_service=GrantService(repo=grant_repo, members=member_repo),
            member_service=MemberDeptService(repo=member_repo),
            audit_recorder=build_enterprise_audit_repository(router),
            knowledge_binding=EmployeeKnowledgeBindingRepository(router),
            platform_catalog=request.app.state._operator_catalog,
        )
        backend = getattr(request.app.state, "_hindsight_client", None) or HindsightClient()
        service = build_memory_service(
            snapshot=snapshot,
            backend=backend,
            employee_reader=EmployeeConfigRepository(router),
        )
        request.app.state._memory_service = service
    return service


def _delete_key(tenant_id: str, employee_id: str, memory_id: str) -> str:
    """Stable retry key when clients do not provide one; no local idempotency store needed."""
    raw = f"{tenant_id}:{employee_id}:{memory_id}".encode()
    return f"memory-delete-{hashlib.sha256(raw).hexdigest()}"


def build_memory_items_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/memories", tags=["manager", "hindsight"])
    require = require_claims(verifier)

    @router.get(
        "/analytics",
        summary="读取各专家 Hindsight 记忆统计",
        description="返回经当前 employee snapshot 授权的记忆数量、分类、重要度和新鲜度；不可用时返回状态而非上游凭据。",
        operation_id="manager_memory_analytics",
    )
    async def memory_analytics(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[MemoryAnalyticsOut]:
        data = await asyncio.to_thread(
            _service(request).analytics, tenant_context_from(claims),
        )
        return ListEnvelope[MemoryAnalyticsOut](
            data=[MemoryAnalyticsOut.model_validate(data)],
        )

    @router.get("", summary="列出指定专家的 Hindsight 记忆", operation_id="manager_memory_list")
    async def list_memories(
        request: Request,
        employee_id: str = Query(min_length=1),
        keyword: str | None = Query(default=None, max_length=500),
        limit: int = Query(default=100, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[MemoryItemOut]:
        result = _service(request).list(
            tenant_context_from(claims), employee_id=employee_id,
            query=keyword, limit=limit, offset=offset,
        )
        return ListEnvelope[MemoryItemOut](
            data=[MemoryItemOut(**item) for item in result["items"]],
            meta={"total": result["total"], "limit": result["limit"], "offset": result["offset"]},
        )

    @router.get("/recall", summary="从 Hindsight 检索记忆", operation_id="manager_memory_recall", response_model_exclude_none=True)
    async def recall(
        request: Request,
        employee_id: str = Query(min_length=1),
        query: str = Query(min_length=1),
        limit: int = Query(default=10, ge=1, le=100),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[MemoryResultOut]:
        data = _service(request).recall(
            tenant_context_from(claims), employee_id=employee_id, query=query, limit=limit,
        )
        return Envelope[MemoryResultOut](data=MemoryResultOut.model_validate(data))

    @router.post("", summary="写入 Hindsight 记忆", operation_id="manager_memory_create",
                 status_code=status.HTTP_201_CREATED, response_model_exclude_none=True)
    @router.post("/retain", summary="写入 Hindsight 记忆", operation_id="manager_memory_retain",
                 status_code=status.HTTP_201_CREATED, response_model_exclude_none=True)
    async def retain(
        body: MemoryRetainIn,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[MemoryResultOut]:
        data = _service(request).retain(
            tenant_context_from(claims), employee_id=body.employee_id,
            content=body.content, metadata=body.metadata,
        )
        return Envelope[MemoryResultOut](data=MemoryResultOut.model_validate(data))

    @router.patch("/{memory_id}", summary="编辑 Hindsight 记忆", operation_id="manager_memory_update", response_model_exclude_none=True)
    async def update_memory(
        memory_id: str,
        body: MemoryUpdateIn,
        request: Request,
        employee_id: str = Query(min_length=1),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[MemoryResultOut]:
        if body.text is None and body.content is None and body.state is None:
            from shared.errors import ValidationProblem
            raise ValidationProblem(detail="memory update requires text or state", errors=None)
        payload = body.model_dump(exclude_none=True)
        if "text" not in payload and "content" in payload:
            payload["text"] = payload.pop("content")
        else:
            payload.pop("content", None)
        data = _service(request).update(
            tenant_context_from(claims), employee_id=employee_id, memory_id=memory_id,
            payload=payload,
        )
        return Envelope[MemoryResultOut](data=MemoryResultOut.model_validate(data))

    @router.delete("/{memory_id}", summary="删除 Hindsight 记忆", operation_id="manager_memory_delete",
                   status_code=status.HTTP_204_NO_CONTENT)
    async def delete_memory(
        memory_id: str,
        request: Request,
        employee_id: str = Query(min_length=1),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        claims: TokenClaims = Depends(require),
    ) -> Response:
        ctx = tenant_context_from(claims)
        _service(request).delete(
            ctx,
            employee_id=employee_id,
            memory_id=memory_id,
            idempotency_key=idempotency_key or _delete_key(ctx.tenant_id, employee_id, memory_id),
        )
        # Hindsight may acknowledge an asynchronous/pending delete.  204 remains the
        # established Manager contract; the stable key makes retries safe until settled.
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router
