"""Operator platform Provider/model/rate administration and Manager service pull."""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import authorize, require_claims
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.contracts.platform_provider import PlatformModel, PlatformModelRate, PlatformProvider, TenantProviderAccess
from shared.errors import AppError
from shared.service_token import verify_service_token

from .platform_provider_service import PlatformProviderService, build_platform_provider_service


class ModelRateCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model_id: str = Field(min_length=1, max_length=256)
    pricing_status: Literal["known", "unknown"] = "known"
    billing_mode: Literal["token", "request"] = "token"
    input_usd_per_million: Decimal | None = Field(default=None, ge=0)
    output_usd_per_million: Decimal | None = Field(default=None, ge=0)
    cache_read_usd_per_million: Decimal | None = Field(default=None, ge=0)
    cache_write_usd_per_million: Decimal | None = Field(default=None, ge=0)
    request_usd: Decimal | None = Field(default=None, ge=0)
    source: Literal["manual", "provider", "public_reference", "unknown"] = "manual"
    source_version: str | None = None
    effective_from: datetime | None = None


class ModelPublishRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model_id: str = Field(min_length=1, max_length=256)


class TenantAccessResolve(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant_id: str
    provider_id: str
    model_ids: list[str] = Field(min_length=1)


class TenantRuntimeAccessOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    access: TenantProviderAccess
    relay_base_url: str
    api_protocol: str
    relay_token: str = Field(repr=False)


class PublicPricingSyncOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: str = Field(description="价格来源。")
    updated: int = Field(description="已更新的价格条数。")
    skipped_known: int = Field(description="已存在且被跳过的价格条数。")
    skipped_manual: int = Field(description="手工价格被保留的条数。")
    unmatched: int = Field(description="未匹配到模型的条数。")


class PlatformModelWithRateOut(BaseModel):
    """Provider model plus its current optional USD rate card."""

    model_config = ConfigDict(extra="forbid")
    model: PlatformModel
    rate: PlatformModelRate | None = None


class PlatformModelListOut(BaseModel):
    """Provider 下的平台模型列表。"""

    model_config = ConfigDict(extra="forbid")
    items: list[PlatformModelWithRateOut] = Field(default_factory=list, description="该 Provider 的模型列表。")


class PublishedCountOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    published: int = Field(ge=0, description="已发布模型数量。")


class PlatformCatalogOut(BaseModel):
    """Manager 使用的已发布 Provider/Model 目录。"""

    model_config = ConfigDict(extra="forbid")
    providers: list[PlatformProvider] = Field(default_factory=list, description="已发布平台 Provider。")
    models: list[PlatformModel] = Field(default_factory=list, description="已发布平台模型。")


class _ProviderNotConfigured(AppError):
    status, code, title = 503, "platform_provider_unconfigured", "Platform Provider Unconfigured"


def _service(request: Request) -> PlatformProviderService:
    cache = getattr(request.app.state, "_platform_provider_service", None)
    if cache is not None:
        return cache
    try:
        cache = build_platform_provider_service()
    except Exception as exc:
        raise _ProviderNotConfigured("Operator LLM gateway settings are incomplete") from exc
    request.app.state._platform_provider_service = cache
    return cache


def _platform_admin(request: Request) -> TokenClaims:
    claims = require_claims(request.app.state._token_verifier)(request)
    authorize(claims, ["system_admin", "system_operator"])
    return claims


router = APIRouter(prefix="/api/operation", tags=["operation-platform-provider"])


@router.get("/providers", operation_id="operation_platform_provider_list")
def list_providers(request: Request, _claims=Depends(_platform_admin)) -> ListEnvelope[PlatformProvider]:
    return ListEnvelope(data=_service(request).list_providers())


@router.post("/providers/{provider_id}/sync-models", operation_id="operation_platform_provider_sync_models")
def sync_models(provider_id: str, request: Request, _claims=Depends(_platform_admin)) -> ListEnvelope[PlatformModel]:
    return ListEnvelope(data=_service(request).sync_models(provider_id))


@router.get("/providers/{provider_id}/models", operation_id="operation_platform_model_list")
def list_models(provider_id: str, request: Request, _claims=Depends(_platform_admin)) -> Envelope[PlatformModelListOut]:
    return Envelope(data=PlatformModelListOut(items=_service(request).list_models(provider_id)))


@router.post("/providers/{provider_id}/sync-public-prices", operation_id="operation_platform_model_public_price_sync")
def sync_public_prices(provider_id: str, request: Request, _claims=Depends(_platform_admin)) -> Envelope[PublicPricingSyncOut]:
    service = _service(request)
    result = service.sync_public_prices(provider_id, force=True)
    service.publish_priced_models(provider_id)
    return Envelope(data=result)


@router.post("/providers/{provider_id}/rates", status_code=status.HTTP_201_CREATED, operation_id="operation_platform_model_rate_create")
def create_rate(provider_id: str, body: ModelRateCreate, request: Request, _claims=Depends(_platform_admin)) -> Envelope[PlatformModelRate]:
    values = body.model_dump()
    model_id = values.pop("model_id")
    return Envelope(data=_service(request).set_rate(provider_id, model_id, **values))


@router.post("/providers/{provider_id}/models/publish", operation_id="operation_platform_model_publish")
def publish_model(provider_id: str, body: ModelPublishRequest, request: Request, _claims=Depends(_platform_admin)) -> Envelope[PlatformModel]:
    return Envelope(data=_service(request).publish_model(provider_id, body.model_id))


@router.post("/providers/{provider_id}/models/publish-priced", operation_id="operation_platform_models_publish_priced")
def publish_priced_models(provider_id: str, request: Request, _claims=Depends(_platform_admin)) -> Envelope[PublishedCountOut]:
    return Envelope(data=PublishedCountOut(**_service(request).publish_priced_models(provider_id)))


@router.get("/catalog/platform-providers", operation_id="operation_platform_provider_pull")
def pull_platform_catalog(request: Request, _svc=Depends(verify_service_token)) -> Envelope[PlatformCatalogOut]:
    service = _service(request)
    providers = service.list_providers(published_only=True)
    return Envelope(data=PlatformCatalogOut(providers=providers, models=[item for provider in providers for item in service.list_models(provider.provider_id, published_only=True)]))


@router.post("/provider-access/resolve", operation_id="operation_tenant_provider_access_resolve")
def resolve_tenant_access(body: TenantAccessResolve, request: Request, response: Response, _svc=Depends(verify_service_token)) -> Envelope[TenantRuntimeAccessOut]:
    response.headers["Cache-Control"] = "no-store"
    return Envelope(data=TenantRuntimeAccessOut(**_service(request).resolve_tenant_access(**body.model_dump())))
