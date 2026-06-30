"""记忆条目编排（B07）。"""

from __future__ import annotations

from shared.contracts.tenancy import TenantContext
from shared.errors import NotFound

from .memory_items_repository import MemoryItemsRepository


class MemoryItemsService:
    def __init__(self, repo: MemoryItemsRepository):
        self._repo = repo

    def list_memories(self, ctx: TenantContext, *, employee_id: str | None = None,
                      keyword: str | None = None, category: str | None = None) -> list[dict]:
        rows = self._repo.list(ctx, employee_id=employee_id, keyword=keyword, category=category)
        return [_to_dict(r) for r in rows]

    def create_memory(self, ctx: TenantContext, *, employee_id: str, content: str,
                      category: str, importance: int) -> dict:
        row = self._repo.create(ctx, employee_id=employee_id, content=content,
                                category=category, importance=importance)
        return _to_dict(row)

    def patch_memory(self, ctx: TenantContext, memory_id: str, *,
                     content: str | None, category: str | None, importance: int | None) -> dict:
        row = self._repo.update(ctx, memory_id, content=content, category=category, importance=importance)
        if row is None:
            raise NotFound("memory item not found in this tenant")
        return _to_dict(row)

    def delete_memory(self, ctx: TenantContext, memory_id: str) -> None:
        if not self._repo.delete(ctx, memory_id):
            raise NotFound("memory item not found in this tenant")

    def bulk_delete(self, ctx: TenantContext, memory_ids: list[str]) -> int:
        return self._repo.bulk_delete(ctx, memory_ids)


def _to_dict(row) -> dict:
    return {
        "memory_id": row.memory_id,
        "employee_id": row.employee_id,
        "content": row.content,
        "category": row.category,
        "importance": row.importance,
        "source": row.source,
        "created_at": row.created_at,
        "last_used_at": row.last_used_at,
    }
