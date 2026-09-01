"""Manager read-only projection of Operator-published platform models (D18)."""
from fastapi import APIRouter, Depends, Request

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope

from .openapi_schemas import PlatformCatalogOut


def _list_platform_catalog(catalog, tenant_id: str) -> dict:
    try:
        return catalog.list_platform_catalog(tenant_id=tenant_id)
    except TypeError:
        # Keep explicit lightweight test doubles compatible with the old no-arg seam.
        return catalog.list_platform_catalog()


def build_platform_model_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/platform-models", tags=["manager", "platform-model"])
    require = require_claims(verifier)

    @router.get("", operation_id="manager_platform_model_list")
    async def list_platform_models(request: Request, claims: TokenClaims = Depends(require)) -> Envelope[PlatformCatalogOut]:
        claims_ctx = tenant_context_from(claims)
        catalog = _list_platform_catalog(request.app.state._operator_catalog, claims_ctx.tenant_id)
        return Envelope(data=PlatformCatalogOut(**catalog))

    return router
