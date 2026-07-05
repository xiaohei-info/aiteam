"""审计事件编排。"""

from __future__ import annotations

from shared.contracts.tenancy import TenantContext

from .audit_repository import AuditRepository


class AuditService:
    def __init__(self, repo: AuditRepository):
        self._repo = repo

    def list_events(self, ctx: TenantContext, *, event_type: str | None = None,
                    target_type: str | None = None, page: int = 1, page_size: int = 20) -> list[dict]:
        rows = self._repo.list_events(ctx, event_type=event_type, target_type=target_type,
                                      page=page, page_size=page_size)
        return [
            {
                "event_id": r.event_id, "event_type": r.event_type, "actor_id": r.actor_id,
                "target_type": r.target_type, "target_id": r.target_id,
                "detail": r.detail, "created_at": r.created_at,
            }
            for r in rows
        ]

    def create_event(self, ctx: TenantContext, *, event_type: str, actor_id: str | None = None,
                     target_type: str | None = None, target_id: str | None = None,
                     detail: dict | None = None) -> dict:
        row = self._repo.create_event(
            ctx, event_type=event_type, actor_id=actor_id,
            target_type=target_type, target_id=target_id, detail=detail,
        )
        return {
            "event_id": row.event_id, "event_type": row.event_type, "actor_id": row.actor_id,
            "target_type": row.target_type, "target_id": row.target_id,
            "detail": row.detail, "created_at": row.created_at,
        }
