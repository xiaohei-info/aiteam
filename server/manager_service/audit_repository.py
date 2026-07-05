"""审计事件 租户作用域数据访问。

表 audit_event 由 0011 创建。
tenant_id 只从 TenantContext 读（D22）。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from shared.db import PgTenantRouter
from shared.contracts.tenancy import TenantContext


@dataclass(frozen=True)
class AuditEventRow:
    event_id: str
    event_type: str
    actor_id: str | None
    target_type: str | None
    target_id: str | None
    detail: dict
    created_at: datetime


def _row_to_audit(row: Any) -> AuditEventRow:
    return AuditEventRow(
        event_id=str(row[0]), event_type=row[1], actor_id=str(row[2]) if row[2] else None,
        target_type=row[3], target_id=str(row[4]) if row[4] else None,
        detail=row[5] if isinstance(row[5], dict) else {},
        created_at=row[6],
    )


class AuditRepository:
    def __init__(self, router: PgTenantRouter):
        self._router = router

    def list_events(self, ctx: TenantContext, *, event_type: str | None = None,
                    target_type: str | None = None, page: int = 1, page_size: int = 20) -> list[AuditEventRow]:
        clauses = []
        params: list = []
        if event_type:
            clauses.append("event_type = %s")
            params.append(event_type)
        if target_type:
            clauses.append("target_type = %s")
            params.append(target_type)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        offset = (page - 1) * page_size
        params.extend([page_size, offset])
        with self._router.session(ctx) as s:
            rows = s.execute(
                f"SELECT id, event_type, actor_id, target_type, target_id, detail, created_at "
                f"FROM audit_event {where} ORDER BY created_at DESC LIMIT %s OFFSET %s",
                tuple(params),
            ).fetchall()
        return [_row_to_audit(r) for r in rows]

    def create_event(self, ctx: TenantContext, *, event_type: str, actor_id: str | None = None,
                     target_type: str | None = None, target_id: str | None = None,
                     detail: dict | None = None) -> AuditEventRow:
        import json
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO audit_event (tenant_id, event_type, actor_id, target_type, target_id, detail) "
                "VALUES (%s, %s, %s, %s, %s, %s) "
                "RETURNING id, event_type, actor_id, target_type, target_id, detail, created_at",
                (ctx.tenant_id, event_type, actor_id, target_type, target_id,
                 json.dumps(detail or {})),
            ).fetchone()
        return _row_to_audit(row)
