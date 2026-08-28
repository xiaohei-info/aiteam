"""Manager protected runtime access for Operator-owned platform Providers (D18).

Manager has no Provider CRUD. The only secret-bearing response is employee-scoped,
authorization-checked, and `Cache-Control: no-store`.
"""
from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope
from shared.crypto import CryptoService
from shared.db import PgTenantRouter
from shared.errors import AppError

from .employee_bindings_repositories import EmployeeKnowledgeBindingRepository
from .employee_config_service import build_employee_config_service
from .member_service import GrantService, MemberDeptService
from .provider_credential_service import ProviderCredentialService, build_provider_credential_service
from .repository_member import GrantRepository, MemberDeptRepository
from .schemas_provider import RuntimeProviderConfigOut, RuntimeProviderConfigRequest
from .snapshot_service import build_snapshot_service


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _snapshot_service(request: Request):
    cache = getattr(request.app.state, "_snapshot_service", None)
    if cache is None:
        dsn = request.app.state.settings.db_url
        if not dsn:
            raise _ManagerNotConfigured("Manager business DB is not configured")
        router = PgTenantRouter(dsn)
        members = MemberDeptRepository(router)
        cache = build_snapshot_service(
            config_service=build_employee_config_service(router),
            grant_service=GrantService(repo=GrantRepository(router), members=members),
            member_service=MemberDeptService(repo=members),
            knowledge_binding=EmployeeKnowledgeBindingRepository(router),
            platform_catalog=getattr(request.app.state, "_operator_catalog", None),
        )
        request.app.state._snapshot_service = cache
    return cache


def _service(request: Request) -> ProviderCredentialService:
    cache = getattr(request.app.state, "_provider_credential_service", None)
    if cache is None:
        dsn = request.app.state.settings.db_url
        if not dsn:
            raise _ManagerNotConfigured("Manager business DB is not configured")
        # Runtime access never reads Manager-owned Provider secrets; this lazy wrapper is retained
        # only because the cutover service still contains unreachable legacy methods.
        crypto = getattr(request.app.state, "_crypto_service", None) or CryptoService()
        request.app.state._crypto_service = crypto
        cache = build_provider_credential_service(
            PgTenantRouter(dsn), crypto, _snapshot_service(request),
            getattr(request.app.state, "_operator_catalog", None),
        )
        request.app.state._provider_credential_service = cache
    return cache


def build_provider_credential_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/provider-credentials", tags=["manager", "platform-provider-runtime"])
    require = require_claims(verifier)

    @router.post("/runtime-config", operation_id="manager_provider_runtime_config")
    async def get_runtime_config(
        body: RuntimeProviderConfigRequest,
        request: Request,
        response: Response,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[RuntimeProviderConfigOut]:
        response.headers["Cache-Control"] = "no-store"
        return Envelope(data=_service(request).runtime_config(tenant_context_from(claims), employee_id=body.employee_id))

    return router
