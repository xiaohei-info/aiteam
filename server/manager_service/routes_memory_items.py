"""Authenticated Manager facade over the external Hindsight memory service.

Manager owns authorization and tenant context; Hindsight owns memory storage.  No
local memory CRUD repository is constructed here.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope
from .hindsight_client import HindsightClient


class MemoryRetainIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_id: str
    content: str = Field(min_length=1)
    metadata: dict = Field(default_factory=dict)


def _client(request: Request) -> HindsightClient:
    client = getattr(request.app.state, "_hindsight_client", None)
    if client is None:
        client = HindsightClient()
        request.app.state._hindsight_client = client
    return client


def build_memory_items_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/memories", tags=["manager", "hindsight"])
    require = require_claims(verifier)

    @router.get("/recall", summary="从 Hindsight 检索记忆", operation_id="manager_memory_recall")
    async def recall(
        request: Request,
        employee_id: str,
        query: str = Query(min_length=1),
        limit: int = Query(default=10, ge=1, le=100),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[dict]:
        data = _client(request).recall(
            tenant_context_from(claims), employee_id=employee_id, query=query, limit=limit,
        )
        return Envelope(data=data)

    @router.post("/retain", summary="写入 Hindsight 记忆", operation_id="manager_memory_retain",
                 status_code=status.HTTP_201_CREATED)
    async def retain(
        body: MemoryRetainIn,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[dict]:
        data = _client(request).retain(
            tenant_context_from(claims), employee_id=body.employee_id,
            content=body.content, metadata=body.metadata,
        )
        return Envelope(data=data)

    @router.delete("/{memory_id}", summary="删除 Hindsight 记忆", operation_id="manager_memory_delete",
                   status_code=status.HTTP_204_NO_CONTENT)
    async def delete_memory(
        memory_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        _client(request).delete(tenant_context_from(claims), memory_id=memory_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router
