"""Manager read-only projection of Operator-published platform models (D18)."""
from fastapi import APIRouter, Depends, Request

from shared.auth import require_claims
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope

from .openapi_schemas import PlatformCatalogOut


def build_platform_model_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/platform-models", tags=["manager", "platform-model"])
    require = require_claims(verifier)

    @router.get("", operation_id="manager_platform_model_list")
    async def list_platform_models(request: Request, _claims: TokenClaims = Depends(require)) -> Envelope[PlatformCatalogOut]:
        catalog = request.app.state._operator_catalog.list_platform_catalog()
        return Envelope(data=PlatformCatalogOut(**catalog))

    return router
