"""Manager 企业端协作模板 + 审计事件路由。

协作模板（群聊编排提示词模板）+ 审计事件查询。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .collab_audit_repository import CollabAuditRepository
from .collab_audit_service import CollabAuditService
from .routes_collab_schemas import (
    AuditEventOut,
    CollaborationTemplateIn,
    CollaborationTemplateOut,
)


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> CollabAuditService:
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_collab_audit_service", None)
    if cache is None:
        cache = CollabAuditService(CollabAuditRepository(PgTenantRouter(dsn)))
        request.app.state._collab_audit_service = cache
    return cache


def build_collab_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/collaboration-template", tags=["manager", "collaboration"])
    require = require_claims(verifier)

    @router.get("", summary="获取协作模板", operation_id="manager_collab_template_get")
    async def get_template(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[CollaborationTemplateOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.get_template(ctx)
        return Envelope(data=CollaborationTemplateOut(**data))

    @router.put("", summary="更新协作模板", operation_id="manager_collab_template_put")
    async def put_template(
        body: CollaborationTemplateIn,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[CollaborationTemplateOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.put_template(
            ctx, name=body.name, routing_prompt=body.routing_prompt,
            handoff_prompt=body.handoff_prompt, max_replies_per_message=body.max_replies_per_message,
        )
        return Envelope(data=CollaborationTemplateOut(**data))

    return router


def build_audit_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/audit-events", tags=["manager", "audit"])
    require = require_claims(verifier)

    @router.get("", summary="查询审计事件", operation_id="manager_audit_events")
    async def list_audit_events(
        request: Request,
        event_type: str | None = Query(default=None),
        target_type: str | None = Query(default=None),
        target_id: str | None = Query(default=None),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=20, ge=1, le=100),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[AuditEventOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        items = svc.list_events(ctx, event_type=event_type, target_type=target_type,
                                target_id=target_id, page=page, page_size=page_size)
        return ListEnvelope(data=[AuditEventOut(**r) for r in items])

    return router
