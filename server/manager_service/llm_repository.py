"""LLM Provider/Model 租户作用域数据访问。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from shared.db import PgTenantRouter
from shared.contracts.tenancy import TenantContext


@dataclass(frozen=True)
class LlmProviderRow:
    provider_id: str
    name: str
    provider_key: str
    base_url: str | None
    is_active: bool
    model_count: int
    created_at: datetime


@dataclass(frozen=True)
class LlmModelRow:
    model_id: str
    provider_id: str
    model_uid: str
    model_name: str
    context_window: int | None
    input_price: str | None
    output_price: str | None
    is_active: bool


def _row_to_provider(row: Any) -> LlmProviderRow:
    return LlmProviderRow(
        provider_id=str(row[0]), name=row[1], provider_key=row[2],
        base_url=row[3], is_active=bool(row[4]), model_count=int(row[5] or 0),
        created_at=row[6],
    )


def _row_to_model(row: Any) -> LlmModelRow:
    return LlmModelRow(
        model_id=str(row[0]), provider_id=str(row[1]), model_uid=row[2],
        model_name=row[3], context_window=row[4], input_price=row[5],
        output_price=row[6], is_active=bool(row[7]),
    )


class LlmRepository:
    def __init__(self, router: PgTenantRouter):
        self._router = router

    def list_providers(self, ctx: TenantContext, keyword: str | None = None) -> list[LlmProviderRow]:
        with self._router.session(ctx) as s:
            if keyword:
                rows = s.execute(
                    "SELECT p.id, p.name, p.provider_key, p.base_url, p.is_active, "
                    "(SELECT count(*) FROM llm_model m WHERE m.provider_id = p.id) as model_count, p.created_at "
                    "FROM llm_provider p WHERE p.name ILIKE %s ORDER BY p.created_at DESC",
                    (f"%{keyword}%",),
                ).fetchall()
            else:
                rows = s.execute(
                    "SELECT p.id, p.name, p.provider_key, p.base_url, p.is_active, "
                    "(SELECT count(*) FROM llm_model m WHERE m.provider_id = p.id), p.created_at "
                    "FROM llm_provider p ORDER BY p.created_at DESC",
                ).fetchall()
        return [_row_to_provider(r) for r in rows]

    def get_provider(self, ctx: TenantContext, provider_id: str) -> LlmProviderRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT id, name, provider_key, base_url, is_active, 0, created_at "
                "FROM llm_provider WHERE id = %s",
                (provider_id,),
            ).fetchone()
        return _row_to_provider(row) if row else None

    def create_provider(
        self, ctx: TenantContext, *, name: str, provider_key: str, base_url: str | None,
    ) -> LlmProviderRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO llm_provider (tenant_id, name, provider_key, base_url) "
                "VALUES (%s, %s, %s, %s) "
                "RETURNING id, name, provider_key, base_url, is_active, 0, created_at",
                (ctx.tenant_id, name, provider_key, base_url),
            ).fetchone()
        return _row_to_provider(row)

    def update_provider(
        self, ctx: TenantContext, provider_id: str, *, name: str | None,
        base_url: str | None, is_active: bool | None,
    ) -> LlmProviderRow | None:
        fields = []
        params: list = []
        if name is not None:
            fields.append("name = %s")
            params.append(name)
        if base_url is not None:
            fields.append("base_url = %s")
            params.append(base_url)
        if is_active is not None:
            fields.append("is_active = %s")
            params.append(is_active)
        if not fields:
            return self.get_provider(ctx, provider_id)
        fields.append("updated_at = now()")
        params.append(provider_id)
        with self._router.session(ctx) as s:
            row = s.execute(
                f"UPDATE llm_provider SET {', '.join(fields)} WHERE id = %s "
                "RETURNING id, name, provider_key, base_url, is_active, 0, created_at",
                tuple(params),
            ).fetchone()
        return _row_to_provider(row) if row else None

    def delete_provider(self, ctx: TenantContext, provider_id: str) -> bool:
        with self._router.session(ctx) as s:
            cur = s.execute("DELETE FROM llm_provider WHERE id = %s", (provider_id,))
            return cur.rowcount > 0

    def list_models(self, ctx: TenantContext, provider_id: str | None = None) -> list[LlmModelRow]:
        with self._router.session(ctx) as s:
            if provider_id:
                rows = s.execute(
                    "SELECT id, provider_id, model_uid, model_name, context_window, "
                    "input_price, output_price, is_active FROM llm_model WHERE provider_id = %s ORDER BY model_uid",
                    (provider_id,),
                ).fetchall()
            else:
                rows = s.execute(
                    "SELECT id, provider_id, model_uid, model_name, context_window, "
                    "input_price, output_price, is_active FROM llm_model ORDER BY model_uid",
                ).fetchall()
        return [_row_to_model(r) for r in rows]

    def create_model(
        self, ctx: TenantContext, *, provider_id: str, model_uid: str, model_name: str,
        context_window: int | None, input_price: str | None, output_price: str | None,
    ) -> LlmModelRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO llm_model (tenant_id, provider_id, model_uid, model_name, "
                "context_window, input_price, output_price) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s) "
                "RETURNING id, provider_id, model_uid, model_name, context_window, input_price, output_price, is_active",
                (ctx.tenant_id, provider_id, model_uid, model_name, context_window, input_price, output_price),
            ).fetchone()
        return _row_to_model(row)

    def delete_model(self, ctx: TenantContext, model_id: str) -> bool:
        with self._router.session(ctx) as s:
            cur = s.execute("DELETE FROM llm_model WHERE id = %s", (model_id,))
            return cur.rowcount > 0
