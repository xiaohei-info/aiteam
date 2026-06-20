"""provider 凭据/AI Relay 管理面北向路由（M5，02 §10.1/§10.3 + 04 §6.7，D18）。

路径：/api/manager/provider-credentials/*。受保护端点（require_claims）；写操作需 owner/enterprise_admin。
统一 envelope（02 §10.3.4）+ problem+json（02 §11.2）。tenant_id 经 TenantContext（D22）。

红线（04 §6.7，D18）：响应**绝不**回明文 key/令牌（也不回密文）——出参 schema 已硬约束无 secret 字段。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import Response

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.crypto import CryptoService, build_crypto_service
from shared.db import PgTenantRouter
from shared.errors import AppError

from .provider_credential_service import (
    ProviderCredentialService,
    build_provider_credential_service,
)
from .schemas_provider import ProviderCredentialCreate, ProviderCredentialOut, ProviderCredentialUpdate


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> ProviderCredentialService:
    """从端配置构造 ProviderCredentialService；未配置业务 DB → 503（不静默）。

    CryptoService 与 PG router 均在 app.state 缓存（单进程单实例，避免反复派生 Fernet key）。
    """
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_provider_credential_service", None)
    if cache is None:
        crypto = getattr(request.app.state, "_crypto_service", None)
        if crypto is None:
            crypto = build_crypto_service()
            request.app.state._crypto_service = crypto
        cache = build_provider_credential_service(PgTenantRouter(dsn), crypto)
        request.app.state._provider_credential_service = cache
    return cache


def build_provider_credential_router(verifier) -> APIRouter:
    """构造 provider 凭据路由；verifier 由 app 持有并闭包注入受保护端点。"""
    router = APIRouter(
        prefix="/api/manager/provider-credentials",
        tags=["manager", "provider-credential"],
    )
    require = require_claims(verifier)

    @router.post(
        "", summary="建 provider 凭据（明文加密存储，不回显）",
        operation_id="manager_provider_credential_create",
        status_code=status.HTTP_201_CREATED,
    )
    async def create_provider_credential(
        body: ProviderCredentialCreate,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[ProviderCredentialOut]:
        svc = _service(request)
        return Envelope[ProviderCredentialOut](
            data=svc.create(tenant_context_from(claims), body)
        )

    @router.get(
        "", summary="列本租户全部 provider 凭据（不回明文）",
        operation_id="manager_provider_credential_list",
    )
    async def list_provider_credentials(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[ProviderCredentialOut]:
        svc = _service(request)
        return ListEnvelope[ProviderCredentialOut](
            data=svc.list_all(tenant_context_from(claims))
        )

    @router.get(
        "/{credential_id}", summary="取单个 provider 凭据（不回明文）",
        operation_id="manager_provider_credential_get",
    )
    async def get_provider_credential(
        credential_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[ProviderCredentialOut]:
        svc = _service(request)
        return Envelope[ProviderCredentialOut](
            data=svc.get(tenant_context_from(claims), credential_id=credential_id)
        )

    @router.put(
        "/{credential_id}", summary="改写 provider 凭据（明文加密存储，version 自增）",
        operation_id="manager_provider_credential_update",
    )
    async def update_provider_credential(
        credential_id: str,
        body: ProviderCredentialUpdate,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[ProviderCredentialOut]:
        svc = _service(request)
        return Envelope[ProviderCredentialOut](
            data=svc.update(tenant_context_from(claims), body, credential_id=credential_id)
        )

    @router.delete(
        "/{credential_id}", summary="删 provider 凭据",
        operation_id="manager_provider_credential_delete",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    async def delete_provider_credential(
        credential_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        svc = _service(request)
        svc.delete(tenant_context_from(claims), credential_id=credential_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router
