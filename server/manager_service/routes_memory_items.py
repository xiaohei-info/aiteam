"""Authenticated Manager facade over employee-private Hindsight memory.

Manager owns current-enterprise authorization; Hindsight owns memory storage. No
local memory CRUD repository is constructed here.
"""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, Path, Query, Request, status
from fastapi.routing import APIRoute
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError, RequestTooLarge

from .employee_bindings_repositories import EmployeeKnowledgeBindingRepository
from .analytics_schemas import MemoryAnalyticsOut
from .employee_config_repository import EmployeeConfigRepository
from .employee_config_service import build_employee_config_service
from .enterprise_audit_repository import build_enterprise_audit_repository
from .hindsight_client import HindsightClient
from .member_service import GrantService, MemberDeptService
from .memory_service import MemoryService, build_memory_service
from .memory_retention_service import build_memory_retention_service
from .openapi_schemas import MemoryResultOut, MemoryWriteAckOut
from .repository_member import GrantRepository, MemberDeptRepository
from .snapshot_service import build_snapshot_service


_MAX_MEMORY_BODY_BYTES = 256 * 1024
_MAX_MEMORY_METADATA_BYTES = 64 * 1024
_MAX_MEMORY_ID_CHARS = 256
_MAX_MEMORY_QUERY_CHARS = 16 * 1024
_MAX_MEMORY_OFFSET = 100_000


class MemoryRetainIn(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_extra={"x-max-body-bytes": _MAX_MEMORY_BODY_BYTES})
    employee_id: str = Field(min_length=1, max_length=_MAX_MEMORY_ID_CHARS)
    content: str = Field(min_length=1, max_length=131072)
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="写入 Hindsight 的附加元数据；JSON UTF-8 序列化后最大 64 KiB。",
        json_schema_extra={"x-max-json-bytes": _MAX_MEMORY_METADATA_BYTES},
    )

    @field_validator("content")
    @classmethod
    def _content_is_nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("content must not be blank")
        return value

    @model_validator(mode="after")
    def _metadata_is_bounded(self):
        import json
        try:
            size = len(json.dumps(self.metadata, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
        except (TypeError, ValueError, UnicodeError) as exc:
            raise ValueError("metadata must be JSON-compatible") from exc
        if size > _MAX_MEMORY_METADATA_BYTES:
            raise ValueError("metadata exceeds the memory metadata limit")
        return self


class MemoryUpdateIn(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={"minProperties": 1, "x-max-body-bytes": _MAX_MEMORY_BODY_BYTES},
    )
    text: str | None = Field(default=None, min_length=1, max_length=131072)
    content: str | None = Field(default=None, min_length=1, max_length=131072)
    state: Literal["valid", "invalidated"] | None = Field(
        default=None,
        description="记忆状态；只能是 valid 或 invalidated。",
    )

    @field_validator("text", "content")
    @classmethod
    def _text_is_nonblank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("memory text must not be blank")
        return value

    @model_validator(mode="after")
    def _requires_change(self):
        if self.text is None and self.content is None and self.state is None:
            raise ValueError("memory update requires text or state")
        return self


def _bounded_memory_body(request: Request) -> None:
    raw_length = request.headers.get("content-length")
    if raw_length is None:
        return
    try:
        length = int(raw_length)
    except ValueError:
        raise RequestTooLarge("memory request body length is invalid") from None
    if length < 0 or length > _MAX_MEMORY_BODY_BYTES:
        raise RequestTooLarge("memory request body exceeds the limit")


class _BoundedMemoryBodyRoute(APIRoute):
    """Limit the ASGI receive stream before FastAPI parses a JSON body."""

    def get_route_handler(self):
        downstream = super().get_route_handler()

        async def handler(request: Request):
            if request.method in {"POST", "PATCH"}:
                _bounded_memory_body(request)
                # Read and bound the ASGI stream before FastAPI's body parser.
                # Storing the accepted bytes on Request lets downstream
                # validation consume the same body without a second receive.
                receive = request.receive
                body = bytearray()
                while True:
                    message = await receive()
                    if message.get("type") != "http.request":
                        break
                    body.extend(message.get("body", b""))
                    if len(body) > _MAX_MEMORY_BODY_BYTES:
                        raise RequestTooLarge("memory request body exceeds the limit")
                    if not message.get("more_body", False):
                        break
                request._body = bytes(body)  # type: ignore[attr-defined]
            return await downstream(request)

        return handler


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
        backend = getattr(request.app.state, "_hindsight_client", None) or HindsightClient(router=router)
        service = build_memory_service(
            snapshot=snapshot,
            backend=backend,
            employee_reader=EmployeeConfigRepository(router),
            retention_service=build_memory_retention_service(request),
        )
        request.app.state._memory_service = service
    return service


def _delete_key(tenant_id: str, employee_id: str, memory_id: str) -> str:
    """Stable retry key when clients do not provide one; no local idempotency store needed."""
    raw = f"{tenant_id}:{employee_id}:{memory_id}".encode()
    return f"memory-delete-{hashlib.sha256(raw).hexdigest()}"


def build_memory_items_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/memories", tags=["manager", "hindsight"], route_class=_BoundedMemoryBodyRoute)
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
        employee_id: str = Query(min_length=1, max_length=_MAX_MEMORY_ID_CHARS),
        keyword: str | None = Query(default=None, max_length=_MAX_MEMORY_QUERY_CHARS),
        limit: int = Query(default=100, ge=1, le=200),
        offset: int = Query(default=0, ge=0, le=_MAX_MEMORY_OFFSET),
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
        employee_id: str = Query(min_length=1, max_length=_MAX_MEMORY_ID_CHARS),
        query: str = Query(min_length=1, max_length=_MAX_MEMORY_QUERY_CHARS),
        limit: int = Query(default=10, ge=1, le=100),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[MemoryResultOut]:
        data = _service(request).recall(
            tenant_context_from(claims), employee_id=employee_id, query=query, limit=limit,
        )
        return Envelope[MemoryResultOut](data=MemoryResultOut.model_validate(data))

    @router.post(
        "",
        summary="写入 Hindsight 记忆",
        operation_id="manager_memory_create",
        status_code=status.HTTP_201_CREATED,
        response_model=Envelope[MemoryWriteAckOut],
        response_model_exclude_none=True,
    )
    @router.post(
        "/retain",
        summary="写入 Hindsight 记忆",
        operation_id="manager_memory_retain",
        status_code=status.HTTP_201_CREATED,
        response_model=Envelope[MemoryWriteAckOut],
        response_model_exclude_none=True,
    )
    async def retain(
        body: MemoryRetainIn,
        request: Request,
        _body_limit: None = Depends(_bounded_memory_body),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[MemoryWriteAckOut]:
        data = _service(request).retain(
            tenant_context_from(claims), employee_id=body.employee_id,
            content=body.content, metadata=body.metadata,
        )
        return Envelope[MemoryWriteAckOut](data=MemoryWriteAckOut.model_validate(data))

    @router.patch("/{memory_id}", summary="编辑 Hindsight 记忆", operation_id="manager_memory_update", response_model_exclude_none=True)
    async def update_memory(
        body: MemoryUpdateIn,
        request: Request,
        memory_id: str = Path(..., min_length=1, max_length=_MAX_MEMORY_ID_CHARS),
        _body_limit: None = Depends(_bounded_memory_body),
        employee_id: str = Query(min_length=1, max_length=_MAX_MEMORY_ID_CHARS),
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
        request: Request,
        memory_id: str = Path(..., min_length=1, max_length=_MAX_MEMORY_ID_CHARS),
        employee_id: str = Query(min_length=1, max_length=_MAX_MEMORY_ID_CHARS),
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
