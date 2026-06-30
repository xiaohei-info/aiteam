"""Manager 企业端 LLM Provider / Model 管理路由（B01 配置面板模型管理）。

边界：Manager 管理 provider 和 model 目录；不下发明文 key（凭据已在 provider_credential 管理）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .llm_repository import LlmRepository
from .llm_service import LlmService
from .routes_llm_schemas import (
    LlmModelCreate,
    LlmModelOut,
    LlmProviderCreate,
    LlmProviderOut,
    LlmProviderPatch,
)


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> LlmService:
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_llm_service", None)
    if cache is None:
        cache = LlmService(LlmRepository(PgTenantRouter(dsn)))
        request.app.state._llm_service = cache
    return cache


def build_llm_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/llm", tags=["manager", "llm"])
    require = require_claims(verifier)

    @router.get("/providers", summary="列出 LLM Provider", operation_id="manager_llm_provider_list")
    async def list_providers(
        request: Request,
        keyword: str | None = Query(default=None),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[LlmProviderOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        items = svc.list_providers(ctx, keyword=keyword)
        return ListEnvelope(data=[LlmProviderOut(**r) for r in items])

    @router.post("/providers", summary="新增 LLM Provider", operation_id="manager_llm_provider_create")
    async def create_provider(
        body: LlmProviderCreate,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[LlmProviderOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.create_provider(ctx, name=body.name, provider_key=body.provider_key, base_url=body.base_url)
        return Envelope(data=LlmProviderOut(**data))

    @router.patch("/providers/{provider_id}", summary="编辑 LLM Provider", operation_id="manager_llm_provider_patch")
    async def patch_provider(
        provider_id: str,
        body: LlmProviderPatch,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[LlmProviderOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.patch_provider(
            ctx, provider_id, name=body.name, base_url=body.base_url, is_active=body.is_active,
        )
        return Envelope(data=LlmProviderOut(**data))

    @router.delete("/providers/{provider_id}", summary="删除 LLM Provider", operation_id="manager_llm_provider_delete")
    async def delete_provider(
        provider_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> dict:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        svc.delete_provider(ctx, provider_id)
        return {"deleted": True, "provider_id": provider_id}

    @router.get("/models", summary="列出 LLM Model（平铺）", operation_id="manager_llm_model_list")
    async def list_models(
        request: Request,
        provider_id: str | None = Query(default=None),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[LlmModelOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        items = svc.list_models(ctx, provider_id=provider_id)
        return ListEnvelope(data=[LlmModelOut(**r) for r in items])

    @router.post("/providers/{provider_id}/models", summary="新增 LLM Model", operation_id="manager_llm_model_create")
    async def create_model(
        provider_id: str,
        body: LlmModelCreate,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[LlmModelOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.create_model(
            ctx, provider_id=provider_id, model_uid=body.model_uid, model_name=body.model_name,
            context_window=body.context_window, input_price=body.input_price, output_price=body.output_price,
        )
        return Envelope(data=LlmModelOut(**data))

    @router.delete("/models/{model_id}", summary="删除 LLM Model", operation_id="manager_llm_model_delete")
    async def delete_model(
        model_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> dict:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        svc.delete_model(ctx, model_id)
        return {"deleted": True, "model_id": model_id}

    return router
