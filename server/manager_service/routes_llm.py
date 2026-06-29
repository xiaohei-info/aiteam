"""Manager 企业端 LLM Provider / Model 管理路由（B01 配置面板模型管理）。

边界：Manager 管理 provider 和 model 目录；不下发明文 key（凭据已在 provider_credential 管理）。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope


class LlmProviderOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider_id: str
    name: str
    provider_key: str
    base_url: str | None = None
    is_active: bool = True
    model_count: int = 0
    created_at: datetime


class LlmProviderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    provider_key: str
    base_url: str | None = None


class LlmProviderPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    base_url: str | None = None
    is_active: bool | None = None


class LlmModelOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model_id: str
    provider_id: str
    model_uid: str
    model_name: str
    context_window: int | None = None
    input_price: str | None = None
    output_price: str | None = None
    is_active: bool = True


class LlmModelCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model_uid: str
    model_name: str
    context_window: int | None = None
    input_price: str | None = None
    output_price: str | None = None


def build_llm_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/llm", tags=["manager", "llm"])
    require = require_claims(verifier)

    @router.get("/providers", summary="列出 LLM Provider", operation_id="manager_llm_provider_list")
    async def list_providers(
        keyword: str | None = Query(default=None),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[LlmProviderOut]:
        tenant_context_from(claims)
        return ListEnvelope(data=[])

    @router.post("/providers", summary="新增 LLM Provider", operation_id="manager_llm_provider_create")
    async def create_provider(
        body: LlmProviderCreate,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[LlmProviderOut]:
        tenant_context_from(claims)
        now = datetime.now(timezone.utc)
        return Envelope(data=LlmProviderOut(
            provider_id=str(uuid4()),
            name=body.name,
            provider_key=body.provider_key,
            base_url=body.base_url,
            model_count=0,
            created_at=now,
        ))

    @router.patch("/providers/{provider_id}", summary="编辑 LLM Provider", operation_id="manager_llm_provider_patch")
    async def patch_provider(
        provider_id: str,
        body: LlmProviderPatch,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[LlmProviderOut]:
        tenant_context_from(claims)
        now = datetime.now(timezone.utc)
        return Envelope(data=LlmProviderOut(
            provider_id=provider_id,
            name=body.name or "",
            provider_key="",
            base_url=body.base_url,
            is_active=body.is_active if body.is_active is not None else True,
            model_count=0,
            created_at=now,
        ))

    @router.delete("/providers/{provider_id}", summary="删除 LLM Provider", operation_id="manager_llm_provider_delete")
    async def delete_provider(
        provider_id: str,
        claims: TokenClaims = Depends(require),
    ) -> dict:
        tenant_context_from(claims)
        return {"deleted": True, "provider_id": provider_id}

    @router.get("/models", summary="列出 LLM Model（平铺）", operation_id="manager_llm_model_list")
    async def list_models(
        provider_id: str | None = Query(default=None),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[LlmModelOut]:
        tenant_context_from(claims)
        return ListEnvelope(data=[])

    @router.post("/providers/{provider_id}/models", summary="新增 LLM Model", operation_id="manager_llm_model_create")
    async def create_model(
        provider_id: str,
        body: LlmModelCreate,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[LlmModelOut]:
        tenant_context_from(claims)
        return Envelope(data=LlmModelOut(
            model_id=str(uuid4()),
            provider_id=provider_id,
            model_uid=body.model_uid,
            model_name=body.model_name,
            context_window=body.context_window,
            input_price=body.input_price,
            output_price=body.output_price,
        ))

    @router.delete("/models/{model_id}", summary="删除 LLM Model", operation_id="manager_llm_model_delete")
    async def delete_model(
        model_id: str,
        claims: TokenClaims = Depends(require),
    ) -> dict:
        tenant_context_from(claims)
        return {"deleted": True, "model_id": model_id}

    return router
