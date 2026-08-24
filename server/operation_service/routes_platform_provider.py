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


class PlatformProviderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider_code: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    display_name: str = Field(min_length=1, max_length=120)
    api_protocol: Literal["openai-completions", "openai-responses", "anthropic-messages"] = "openai-completions"
    newapi_channel_id: int = Field(gt=0)


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


class _ProviderNotConfigured(AppError):
    status, code, title = 503, "platform_provider_unconfigured", "Platform Provider Unconfigured"


def _service(request: Request) -> PlatformProviderService:
    cache = getattr(request.app.state, "_platform_provider_service", None)
    if cache is not None:
        return cache
    try:
        cache = build_platform_provider_service()
    except Exception as exc:
        raise _ProviderNotConfigured("Operator Provider/NewAPI settings are incomplete") from exc
    request.app.state._platform_provider_service = cache
    return cache


def _platform_admin(request: Request) -> TokenClaims:
    claims = require_claims(request.app.state._token_verifier)(request)
    authorize(claims, ["system_admin", "system_operator"])
    return claims


router = APIRouter(prefix="/api/operation", tags=["operation-platform-provider"])


@router.post("/providers", status_code=status.HTTP_201_CREATED, operation_id="operation_platform_provider_create")
def create_provider(body: PlatformProviderCreate, request: Request, _claims=Depends(_platform_admin)) -> Envelope[PlatformProvider]:
    return Envelope(data=_service(request).create_provider(**body.model_dump()))


@router.get("/providers", operation_id="operation_platform_provider_list")
def list_providers(request: Request, _claims=Depends(_platform_admin)) -> ListEnvelope[PlatformProvider]:
    return ListEnvelope(data=_service(request).list_providers())


@router.post("/providers/{provider_id}/sync-models", operation_id="operation_platform_provider_sync_models")
def sync_models(provider_id: str, request: Request, _claims=Depends(_platform_admin)) -> ListEnvelope[PlatformModel]:
    return ListEnvelope(data=_service(request).sync_models(provider_id))


@router.post("/providers/{provider_id}/publish", operation_id="operation_platform_provider_publish")
def publish_provider(provider_id: str, request: Request, _claims=Depends(_platform_admin)) -> Envelope[PlatformProvider]:
    return Envelope(data=_service(request).publish_provider(provider_id))


@router.get("/providers/{provider_id}/models", operation_id="operation_platform_model_list")
def list_models(provider_id: str, request: Request, _claims=Depends(_platform_admin)) -> Envelope[dict]:
    return Envelope(data={"items": _service(request).list_models(provider_id)})


@router.post("/providers/{provider_id}/rates", status_code=status.HTTP_201_CREATED, operation_id="operation_platform_model_rate_create")
def create_rate(provider_id: str, body: ModelRateCreate, request: Request, _claims=Depends(_platform_admin)) -> Envelope[PlatformModelRate]:
    values = body.model_dump()
    model_id = values.pop("model_id")
    return Envelope(data=_service(request).set_rate(provider_id, model_id, **values))


@router.post("/providers/{provider_id}/models/publish", operation_id="operation_platform_model_publish")
def publish_model(provider_id: str, body: ModelPublishRequest, request: Request, _claims=Depends(_platform_admin)) -> Envelope[PlatformModel]:
    return Envelope(data=_service(request).publish_model(provider_id, body.model_id))


@router.get("/catalog/platform-providers", operation_id="operation_platform_provider_pull")
def pull_platform_catalog(request: Request, _svc=Depends(verify_service_token)) -> Envelope[dict]:
    service = _service(request)
    providers = service.list_providers(published_only=True)
    return Envelope(data={"providers": providers, "models": [item for provider in providers for item in service.list_models(provider.provider_id, published_only=True)]})


@router.post("/provider-access/resolve", operation_id="operation_tenant_provider_access_resolve")
def resolve_tenant_access(body: TenantAccessResolve, request: Request, response: Response, _svc=Depends(verify_service_token)) -> Envelope[TenantRuntimeAccessOut]:
    response.headers["Cache-Control"] = "no-store"
    return Envelope(data=TenantRuntimeAccessOut(**_service(request).resolve_tenant_access(**body.model_dump())))
