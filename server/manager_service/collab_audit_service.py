"""协作模板 + 审计事件编排。"""

from __future__ import annotations

from shared.contracts.tenancy import TenantContext

from .collab_audit_repository import CollabAuditRepository


class CollabAuditService:
    def __init__(self, repo: CollabAuditRepository):
        self._repo = repo

    # ---- collaboration template ----

    def get_template(self, ctx: TenantContext) -> dict:
        row = self._repo.get_template(ctx)
        if row is None:
            row = self._repo.upsert_template(ctx)
        return {
            "template_id": row.template_id,
            "name": row.name,
            "routing_prompt": row.routing_prompt,
            "handoff_prompt": row.handoff_prompt,
            "max_replies_per_message": row.max_replies_per_message,
            "updated_at": row.updated_at,
        }

    def put_template(self, ctx: TenantContext, *, name: str | None = None,
                     routing_prompt: str | None = None, handoff_prompt: str | None = None,
                     max_replies_per_message: int | None = None) -> dict:
        row = self._repo.upsert_template(
            ctx, name=name, routing_prompt=routing_prompt,
            handoff_prompt=handoff_prompt, max_replies_per_message=max_replies_per_message,
        )
        return {
            "template_id": row.template_id,
            "name": row.name,
            "routing_prompt": row.routing_prompt,
            "handoff_prompt": row.handoff_prompt,
            "max_replies_per_message": row.max_replies_per_message,
            "updated_at": row.updated_at,
        }

    # ---- audit events ----

    def list_events(self, ctx: TenantContext, *, event_type: str | None = None,
                    target_type: str | None = None, target_id: str | None = None,
                    page: int = 1, page_size: int = 20) -> list[dict]:
        rows = self._repo.list_events(ctx, event_type=event_type, target_type=target_type,
                                      target_id=target_id, page=page, page_size=page_size)
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
