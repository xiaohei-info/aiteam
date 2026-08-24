"""Manager tenant view of Operator-published platform skills."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from shared.auth import authorize, require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.contracts.enums import EnterpriseRole
from shared.contracts.platform_skill import PlatformSkillRef
from shared.db import PgTenantRouter
from shared.errors import AppError

from .capability_catalog_repository import CapabilityCatalogRepository
from .platform_skill_service import PlatformSkillService


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> PlatformSkillService:
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager DB is not configured")
    cache = getattr(request.app.state, "_platform_skill_service", None)
    if cache is None:
        cache = PlatformSkillService(
            operator=request.app.state._operator_catalog,
            catalog=CapabilityCatalogRepository(PgTenantRouter(dsn)),
        )
        request.app.state._platform_skill_service = cache
    return cache


def build_skill_market_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/skill-market", tags=["manager", "skill-market"])
    require = require_claims(verifier)

    @router.get("")
    async def list_market(request: Request, claims: TokenClaims = Depends(require)) -> ListEnvelope[dict]:
        return ListEnvelope(data=_service(request).list_market(tenant_context_from(claims)))

    @router.post("/{skill_id}/install")
    async def install_skill(
        skill_id: str,
        body: PlatformSkillRef,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[dict]:
        authorize(claims, [EnterpriseRole.OWNER.value, EnterpriseRole.ENTERPRISE_ADMIN.value])
        if body.skill_id != skill_id:
            from shared.errors import ValidationProblem
            raise ValidationProblem("skill_id path/body mismatch")
        result = _service(request).install(tenant_context_from(claims), body)
        return Envelope(data=result.__dict__)

    return router
