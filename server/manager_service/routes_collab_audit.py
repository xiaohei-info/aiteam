"""Manager 企业端协作模板 + 审计事件路由。

协作模板（群聊编排提示词模板）+ 审计事件查询。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope


# ---- 协作模板 ----

class CollaborationTemplateOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    template_id: str = "default"
    name: str = "默认协作模板"
    routing_prompt: str = ""
    handoff_prompt: str = ""
    max_replies_per_message: int = 3
    updated_at: datetime


class CollaborationTemplateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    routing_prompt: str | None = None
    handoff_prompt: str | None = None
    max_replies_per_message: int | None = None


# ---- 审计事件 ----

class AuditEventOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: str
    event_type: str
    actor_id: str | None = None
    target_type: str | None = None
    target_id: str | None = None
    detail: dict = {}
    created_at: datetime


def build_collab_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/collaboration-template", tags=["manager", "collaboration"])
    require = require_claims(verifier)

    @router.get("", summary="获取协作模板", operation_id="manager_collab_template_get")
    async def get_template(claims: TokenClaims = Depends(require)) -> Envelope[CollaborationTemplateOut]:
        tenant_context_from(claims)
        now = datetime.now(timezone.utc)
        return Envelope(data=CollaborationTemplateOut(updated_at=now))

    @router.put("", summary="更新协作模板", operation_id="manager_collab_template_put")
    async def put_template(
        body: CollaborationTemplateIn,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[CollaborationTemplateOut]:
        tenant_context_from(claims)
        now = datetime.now(timezone.utc)
        current = CollaborationTemplateOut(updated_at=now)
        if body.name is not None:
            current.name = body.name
        if body.routing_prompt is not None:
            current.routing_prompt = body.routing_prompt
        if body.handoff_prompt is not None:
            current.handoff_prompt = body.handoff_prompt
        if body.max_replies_per_message is not None:
            current.max_replies_per_message = body.max_replies_per_message
        return Envelope(data=current)

    return router


def build_audit_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/audit-events", tags=["manager", "audit"])
    require = require_claims(verifier)

    @router.get("", summary="查询审计事件", operation_id="manager_audit_events")
    async def list_audit_events(
        event_type: str | None = Query(default=None),
        target_type: str | None = Query(default=None),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=20, ge=1, le=100),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[AuditEventOut]:
        tenant_context_from(claims)
        return ListEnvelope(data=[])

    return router
