"""Manager Hindsight protocol adapter and legacy runtime-config compatibility routes."""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Depends, Request, Response

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope
from shared.errors import AppError
from shared.db import PgTenantRouter
from .repository import TenantAuthRepository

from .hindsight_client import HindsightClient, HindsightSettings
from .hindsight_credentials import HindsightRuntimeService
from .hindsight_facade import HindsightFacade
from .hindsight_lease_repository import HindsightLeaseRepository
from .memory_protocol_facade import MemoryProtocolFacade
from .memory_retention_service import build_memory_retention_service
from .schemas_hindsight import (
    HindsightLeaseRevocationOut,
    HindsightMemoryRuntimeConfigOut,
    HindsightRuntimeConfigOut,
    HindsightRuntimeConfigRequest,
)
from .routes_memory_items import _service as _memory_service


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _snapshot_service(request: Request):
    # Reuse the exact snapshot authorizer used by provider runtime-config. The
    # Hindsight route never accepts snapshot/policy/bank input from the Agent.
    from .routes_provider import _snapshot_service as build_snapshot

    return build_snapshot(request)


def _lease_store(request: Request, settings: HindsightSettings):
    """Use the durable store for configured Manager instances; never fall back."""

    leases = getattr(request.app.state, "_hindsight_lease_store", None)
    if leases is not None:
        return leases
    business_dsn = request.app.state.settings.db_url
    admin_dsn = request.app.state.settings.admin_db_url
    if not business_dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    if not admin_dsn:
        raise _ManagerNotConfigured("Manager 管理 DB 未配置（设置 ADMIN_DB_URL）")
    leases = HindsightLeaseRepository(
        business_dsn,
        admin_dsn,
        settings.lease_ttl_seconds,
    )
    request.app.state._hindsight_lease_store = leases
    return leases


def _runtime_service(request: Request) -> HindsightRuntimeService:
    cache = getattr(request.app.state, "_hindsight_runtime_service", None)
    if cache is None:
        settings = HindsightSettings.from_env()
        leases = _lease_store(request, settings)
        cache = HindsightRuntimeService(
            snapshot_service=_snapshot_service(request),
            settings=settings,
            leases=leases,
            bank_client=HindsightClient(settings, router=PgTenantRouter(request.app.state.settings.db_url)),
            retention_service=build_memory_retention_service(request),
        )
        request.app.state._hindsight_runtime_service = cache
    return cache


def _facade(request: Request) -> HindsightFacade:
    cache = getattr(request.app.state, "_hindsight_facade", None)
    if cache is None:
        runtime = getattr(request.app.state, "_hindsight_runtime_service", None)
        settings = (
            runtime.settings if runtime is not None else HindsightSettings.from_env()
        )
        leases = runtime.leases if runtime is not None else _lease_store(request, settings)
        dsn = request.app.state.settings.db_url
        if not dsn:
            raise _ManagerNotConfigured("Manager business DB is not configured")
        cache = HindsightFacade(settings=settings, leases=leases,
                               principal_repository=TenantAuthRepository(PgTenantRouter(dsn)),
                               snapshot_service=_snapshot_service(request),
                               retention_service=build_memory_retention_service(request))
        request.app.state._hindsight_facade = cache
    return cache


def _memory_facade(request: Request) -> MemoryProtocolFacade:
    cache = getattr(request.app.state, "_hindsight_memory_protocol_facade", None)
    if cache is None:
        cache = MemoryProtocolFacade(_memory_service(request))
        request.app.state._hindsight_memory_protocol_facade = cache
    return cache


def build_hindsight_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/hindsight", tags=["manager", "hindsight"])
    require = require_claims(verifier)

    @router.post(
        "/runtime-config",
        summary="按当前 employee snapshot 签发 Hindsight bank lease",
        operation_id="manager_hindsight_runtime_config",
    )
    async def runtime_config(
        body: HindsightRuntimeConfigRequest,
        request: Request,
        response: Response,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[HindsightRuntimeConfigOut]:
        response.headers["Cache-Control"] = "no-store"
        data = _runtime_service(request).runtime_config(
            tenant_context_from(claims),
            employee_id=body.employee_id,
            rotate=body.rotate,
            client_protocol=body.client_protocol,
        )
        return Envelope[HindsightRuntimeConfigOut](data=data)

    @router.post(
        "/leases/{lease_id}/revoke",
        summary="撤销当前成员可见的 Hindsight lease",
        operation_id="manager_hindsight_lease_revoke",
    )
    async def revoke_lease(
        lease_id: str,
        request: Request,
        response: Response,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[HindsightLeaseRevocationOut]:
        response.headers["Cache-Control"] = "no-store"
        data = _runtime_service(request).revoke(
            tenant_context_from(claims),
            lease_id=lease_id,
        )
        return Envelope[HindsightLeaseRevocationOut](data=data)

    @router.post(
        "/memory-runtime-config",
        summary="返回 Pi Hindsight 协议适配所需的 Manager 记忆上下文",
        operation_id="manager_memory_runtime_config",
    )
    async def memory_runtime_config(
        body: HindsightRuntimeConfigRequest,
        request: Request,
        response: Response,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[HindsightMemoryRuntimeConfigOut]:
        response.headers["Cache-Control"] = "no-store"
        ctx = tenant_context_from(claims)
        context = _memory_service(request).runtime_context(ctx, employee_id=body.employee_id)
        base_url = f"{str(request.base_url).rstrip('/')}/api/manager/hindsight/employees/{quote(body.employee_id, safe='')}"
        return Envelope[HindsightMemoryRuntimeConfigOut](data=HindsightMemoryRuntimeConfigOut(
            base_url=base_url,
            bank_id=context["bank_id"],
            allowed_operations=context["allowed_operations"],
            policy_revision=context["policy_revision"],
            client_protocol="aiteam-memory-v1",
            retention_mode=context["retention_mode"],
        ))

    @router.api_route(
        "/employees/{employee_id}/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        include_in_schema=False,
    )
    async def memory_protocol_proxy(
        employee_id: str,
        request: Request,
        path: str,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        return await _memory_facade(request).proxy(
            request,
            path,
            ctx=tenant_context_from(claims),
            employee_id=employee_id,
        )

    @router.api_route(
        "/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        include_in_schema=False,
    )
    async def proxy(request: Request, path: str) -> Response:
        return await _facade(request).proxy(request, path)

    return router
