"""记忆条目 租户作用域数据访问（B07）。

表 memory_item 由 0011_memory_connector_audit.sql 创建。
tenant_id 只从 TenantContext 读（D22）。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from shared.db import PgTenantRouter
from shared.contracts.tenancy import TenantContext


@dataclass(frozen=True)
class MemoryItemRow:
    memory_id: str
    employee_id: str
    content: str
    category: str
    importance: int
    source: str
    created_at: datetime
    last_used_at: datetime | None


def _row_to_memory(row: Any) -> MemoryItemRow:
    return MemoryItemRow(
        memory_id=str(row[0]), employee_id=str(row[1]), content=row[2],
        category=row[3], importance=int(row[4]), source=row[5],
        created_at=row[6], last_used_at=row[7],
    )


class MemoryItemsRepository:
    def __init__(self, router: PgTenantRouter):
        self._router = router

    def list(self, ctx: TenantContext, *, employee_id: str | None = None,
             keyword: str | None = None, category: str | None = None) -> list[MemoryItemRow]:
        clauses = []
        params: list = []
        if employee_id:
            clauses.append("employee_id = %s")
            params.append(employee_id)
        if keyword:
            clauses.append("content ILIKE %s")
            params.append(f"%{keyword}%")
        if category:
            clauses.append("category = %s")
            params.append(category)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = (
            "SELECT id, employee_id, content, category, importance, source, created_at, last_used_at "
            f"FROM memory_item {where} ORDER BY created_at DESC LIMIT 200"
        )
        with self._router.session(ctx) as s:
            rows = s.execute(sql, tuple(params) if params else None).fetchall()
        return [_row_to_memory(r) for r in rows]

    def get(self, ctx: TenantContext, memory_id: str) -> MemoryItemRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT id, employee_id, content, category, importance, source, created_at, last_used_at "
                "FROM memory_item WHERE id = %s",
                (memory_id,),
            ).fetchone()
        return _row_to_memory(row) if row else None

    def create(self, ctx: TenantContext, *, employee_id: str, content: str,
               category: str, importance: int) -> MemoryItemRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO memory_item (tenant_id, employee_id, content, category, importance, source) "
                "VALUES (%s, %s, %s, %s, %s, 'manual') "
                "RETURNING id, employee_id, content, category, importance, source, created_at, last_used_at",
                (ctx.tenant_id, employee_id, content, category, importance),
            ).fetchone()
        return _row_to_memory(row)

    def update(self, ctx: TenantContext, memory_id: str, *,
               content: str | None = None, category: str | None = None,
               importance: int | None = None) -> MemoryItemRow | None:
        fields = []
        params: list = []
        if content is not None:
            fields.append("content = %s")
            params.append(content)
        if category is not None:
            fields.append("category = %s")
            params.append(category)
        if importance is not None:
            fields.append("importance = %s")
            params.append(importance)
        if not fields:
            return self.get(ctx, memory_id)
        params.append(memory_id)
        with self._router.session(ctx) as s:
            row = s.execute(
                f"UPDATE memory_item SET {', '.join(fields)} WHERE id = %s "
                "RETURNING id, employee_id, content, category, importance, source, created_at, last_used_at",
                tuple(params),
            ).fetchone()
        return _row_to_memory(row) if row else None

    def delete(self, ctx: TenantContext, memory_id: str) -> bool:
        with self._router.session(ctx) as s:
            s.execute("DELETE FROM memory_item WHERE id = %s", (memory_id,))
            return True

    def bulk_delete(self, ctx: TenantContext, memory_ids: list[str]) -> int:
        if not memory_ids:
            return 0
        with self._router.session(ctx) as s:
            s.execute(
                "DELETE FROM memory_item WHERE id = ANY(%s)",
                (memory_ids,),
            )
            return len(memory_ids)
