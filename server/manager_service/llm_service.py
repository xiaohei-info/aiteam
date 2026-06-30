"""LLM Provider/Model 编排（B01）。"""

from __future__ import annotations

from shared.contracts.tenancy import TenantContext
from shared.errors import NotFound

from .llm_repository import LlmRepository, LlmProviderRow, LlmModelRow


class LlmService:
    def __init__(self, repo: LlmRepository):
        self._repo = repo

    def list_providers(self, ctx: TenantContext, keyword: str | None = None) -> list[dict]:
        rows = self._repo.list_providers(ctx, keyword=keyword)
        return [_provider_to_dict(r) for r in rows]

    def create_provider(self, ctx: TenantContext, *, name: str, provider_key: str, base_url: str | None) -> dict:
        row = self._repo.create_provider(ctx, name=name, provider_key=provider_key, base_url=base_url)
        return _provider_to_dict(row)

    def patch_provider(self, ctx: TenantContext, provider_id: str, *, name: str | None, base_url: str | None,
                       is_active: bool | None) -> dict:
        row = self._repo.update_provider(ctx, provider_id, name=name, base_url=base_url, is_active=is_active)
        if row is None:
            raise NotFound("provider not found in this tenant")
        return _provider_to_dict(row)

    def delete_provider(self, ctx: TenantContext, provider_id: str) -> None:
        deleted = self._repo.delete_provider(ctx, provider_id)
        if not deleted:
            raise NotFound("provider not found in this tenant")

    def list_models(self, ctx: TenantContext, provider_id: str | None = None) -> list[dict]:
        rows = self._repo.list_models(ctx, provider_id=provider_id)
        return [_model_to_dict(r) for r in rows]

    def create_model(self, ctx: TenantContext, *, provider_id: str, model_uid: str, model_name: str,
                     context_window: int | None, input_price: str | None, output_price: str | None) -> dict:
        # 验证 provider 存在
        if self._repo.get_provider(ctx, provider_id) is None:
            raise NotFound("provider not found in this tenant")
        row = self._repo.create_model(
            ctx, provider_id=provider_id, model_uid=model_uid, model_name=model_name,
            context_window=context_window, input_price=input_price, output_price=output_price,
        )
        return _model_to_dict(row)

    def delete_model(self, ctx: TenantContext, model_id: str) -> None:
        self._repo.delete_model(ctx, model_id)


def _provider_to_dict(row: LlmProviderRow) -> dict:
    return {
        "provider_id": row.provider_id,
        "name": row.name,
        "provider_key": row.provider_key,
        "base_url": row.base_url,
        "is_active": row.is_active,
        "model_count": row.model_count,
        "created_at": row.created_at,
    }


def _model_to_dict(row: LlmModelRow) -> dict:
    return {
        "model_id": row.model_id,
        "provider_id": row.provider_id,
        "model_uid": row.model_uid,
        "model_name": row.model_name,
        "context_window": row.context_window,
        "input_price": row.input_price,
        "output_price": row.output_price,
        "is_active": row.is_active,
    }
