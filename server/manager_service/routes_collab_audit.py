"""Manager 企业端审计事件路由。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .audit_repository import AuditRepository
from .audit_service import AuditService
from .routes_audit_schemas import AuditEventOut


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> AuditService:
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_audit_service", None)
    if cache is None:
        cache = AuditService(AuditRepository(PgTenantRouter(dsn)))
        request.app.state._audit_service = cache
    return cache


def build_audit_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/audit-events", tags=["manager", "audit"])
    require = require_claims(verifier)

    @router.get("", summary="查询审计事件", operation_id="manager_audit_events")
    async def list_audit_events(
        request: Request,
        event_type: str | None = Query(default=None),
        target_type: str | None = Query(default=None),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=20, ge=1, le=100),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[AuditEventOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        items = svc.list_events(ctx, event_type=event_type, target_type=target_type,
                                page=page, page_size=page_size)
        return ListEnvelope(data=[AuditEventOut(**r) for r in items])

    return router
