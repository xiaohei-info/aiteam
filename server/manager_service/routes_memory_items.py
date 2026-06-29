"""Manager 企业端记忆条目管理路由（B07 记忆管理）。

边界：Manager 管理员工记忆条目（CRUD/搜索/批量删除/按员工查看）。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope


class MemoryItemOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    memory_id: str
    employee_id: str
    content: str
    category: str = "preference"
    importance: int = 3
    source: str = "manual"
    created_at: datetime
    last_used_at: datetime | None = None


class MemoryItemCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    employee_id: str
    content: str
    category: str = "preference"
    importance: int = Field(ge=1, le=5, default=3)


class MemoryItemPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str | None = None
    category: str | None = None
    importance: int | None = Field(default=None, ge=1, le=5)


class MemoryBulkDelete(BaseModel):
    model_config = ConfigDict(extra="forbid")

    memory_ids: list[str]


def build_memory_items_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/memories", tags=["manager", "memory-items"])
    require = require_claims(verifier)

    @router.get("", summary="列出记忆条目", operation_id="manager_memory_list")
    async def list_memories(
        employee_id: str | None = Query(default=None),
        keyword: str | None = Query(default=None),
        category: str | None = Query(default=None),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[MemoryItemOut]:
        tenant_context_from(claims)
        return ListEnvelope(data=[])

    @router.post("", summary="新增记忆条目", operation_id="manager_memory_create")
    async def create_memory(
        body: MemoryItemCreate,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[MemoryItemOut]:
        tenant_context_from(claims)
        now = datetime.now(timezone.utc)
        return Envelope(data=MemoryItemOut(
            memory_id=str(uuid4()),
            employee_id=body.employee_id,
            content=body.content,
            category=body.category,
            importance=body.importance,
            source="manual",
            created_at=now,
        ))

    @router.patch("/{memory_id}", summary="编辑记忆条目", operation_id="manager_memory_patch")
    async def patch_memory(
        memory_id: str,
        body: MemoryItemPatch,
        claims: TokenClaims = Depends(require),
    ) -> dict:
        tenant_context_from(claims)
        return {"memory_id": memory_id, "updated": True}

    @router.delete("/{memory_id}", summary="删除记忆条目", operation_id="manager_memory_delete")
    async def delete_memory(
        memory_id: str,
        claims: TokenClaims = Depends(require),
    ) -> dict:
        tenant_context_from(claims)
        return {"deleted": True, "memory_id": memory_id}

    @router.post("/bulk-delete", summary="批量删除记忆条目", operation_id="manager_memory_bulk_delete")
    async def bulk_delete(
        body: MemoryBulkDelete,
        claims: TokenClaims = Depends(require),
    ) -> dict:
        tenant_context_from(claims)
        return {"deleted_count": len(body.memory_ids)}

    return router
