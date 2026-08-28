"""PostgreSQL repository for Operator-owned platform Provider truth (D18)."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

import psycopg
from psycopg.rows import dict_row


@dataclass(frozen=True)
class ProviderRow:
    provider_id: str
    provider_code: str
    display_name: str
    relay_base_url: str
    api_protocol: str
    newapi_channel_id: int | None
    status: str
    version: int
    updated_at: datetime


@dataclass(frozen=True)
class ModelRow:
    provider_id: str
    model_id: str
    display_name: str
    capabilities: dict[str, Any]
    status: str
    source: str
    version: int
    updated_at: datetime


@dataclass(frozen=True)
class RateRow:
    rate_id: str
    provider_id: str
    model_id: str
    pricing_version: int
    pricing_status: str
    billing_mode: str
    input_usd_per_million: Decimal | None
    output_usd_per_million: Decimal | None
    cache_read_usd_per_million: Decimal | None
    cache_write_usd_per_million: Decimal | None
    request_usd: Decimal | None
    currency: str
    source: str
    source_version: str | None
    effective_from: datetime
    effective_to: datetime | None
    manually_overridden: bool


@dataclass(frozen=True)
class AccessRow:
    access_id: str
    tenant_id: str
    provider_id: str
    encrypted_token: bytes
    encrypted_management_token: bytes
    allowed_model_ids: list[str]
    newapi_username: str
    newapi_user_id: int | None
    newapi_token_id: int | None
    status: str
    version: int
    expires_at: datetime | None


class PlatformProviderRepository:
    def __init__(self, dsn: str):
        self._dsn = dsn

    def _connect(self):
        return psycopg.connect(self._dsn, autocommit=True, row_factory=dict_row)

    @staticmethod
    def _provider(row) -> ProviderRow:
        return ProviderRow(**dict(row))

    @staticmethod
    def _model(row) -> ModelRow:
        data = dict(row); data["capabilities"] = dict(data.get("capabilities") or {})
        return ModelRow(**data)

    @staticmethod
    def _rate(row) -> RateRow:
        return RateRow(**dict(row))

    def create_provider(self, *, provider_code: str, display_name: str, relay_base_url: str, api_protocol: str, newapi_channel_id: int | None) -> ProviderRow:
        with self._connect() as conn:
            row = conn.execute(
                """INSERT INTO platform_provider (provider_code,display_name,relay_base_url,api_protocol,newapi_channel_id)
                   VALUES (%s,%s,%s,%s,%s)
                   RETURNING provider_id::text,provider_code,display_name,relay_base_url,api_protocol,newapi_channel_id,status,version,updated_at""",
                (provider_code, display_name, relay_base_url, api_protocol, newapi_channel_id),
            ).fetchone()
        return self._provider(row)

    def list_providers(self, *, published_only: bool = False) -> list[ProviderRow]:
        where = " WHERE status = 'published'" if published_only else ""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT provider_id::text,provider_code,display_name,relay_base_url,api_protocol,newapi_channel_id,status,version,updated_at FROM platform_provider" + where + " ORDER BY created_at"
            ).fetchall()
        return [self._provider(row) for row in rows]

    def get_provider(self, provider_id: str) -> ProviderRow | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT provider_id::text,provider_code,display_name,relay_base_url,api_protocol,newapi_channel_id,status,version,updated_at FROM platform_provider WHERE provider_id=%s::uuid",
                (provider_id,),
            ).fetchone()
        return self._provider(row) if row else None

    def set_provider_status(self, provider_id: str, status: str) -> ProviderRow | None:
        with self._connect() as conn:
            row = conn.execute(
                """UPDATE platform_provider SET status=%s,version=version+1,updated_at=now() WHERE provider_id=%s::uuid
                   RETURNING provider_id::text,provider_code,display_name,relay_base_url,api_protocol,newapi_channel_id,status,version,updated_at""",
                (status, provider_id),
            ).fetchone()
        return self._provider(row) if row else None

    def upsert_discovered_models(self, provider_id: str, model_ids: list[str]) -> list[ModelRow]:
        with self._connect() as conn:
            with conn.transaction():
                for model_id in model_ids:
                    conn.execute(
                        """INSERT INTO platform_model (provider_id,model_id,source) VALUES (%s::uuid,%s,'discovery')
                           ON CONFLICT (provider_id,model_id) DO UPDATE SET updated_at=now()""",
                        (provider_id, model_id),
                    )
                rows = conn.execute(
                    "SELECT provider_id::text,model_id,display_name,capabilities,status,source,version,updated_at FROM platform_model WHERE provider_id=%s::uuid ORDER BY model_id",
                    (provider_id,),
                ).fetchall()
        return [self._model(row) for row in rows]

    def list_models(self, provider_id: str, *, published_only: bool = False) -> list[ModelRow]:
        suffix = " AND status='published'" if published_only else ""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT provider_id::text,model_id,display_name,capabilities,status,source,version,updated_at FROM platform_model WHERE provider_id=%s::uuid" + suffix + " ORDER BY model_id",
                (provider_id,),
            ).fetchall()
        return [self._model(row) for row in rows]

    def get_model(self, provider_id: str, model_id: str) -> ModelRow | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT provider_id::text,model_id,display_name,capabilities,status,source,version,updated_at FROM platform_model WHERE provider_id=%s::uuid AND model_id=%s",
                (provider_id, model_id),
            ).fetchone()
        return self._model(row) if row else None

    def set_model_status(self, provider_id: str, model_id: str, status: str) -> ModelRow | None:
        with self._connect() as conn:
            row = conn.execute(
                """UPDATE platform_model SET status=%s,version=version+1,updated_at=now() WHERE provider_id=%s::uuid AND model_id=%s
                   RETURNING provider_id::text,model_id,display_name,capabilities,status,source,version,updated_at""",
                (status, provider_id, model_id),
            ).fetchone()
        return self._model(row) if row else None

    def publish_priced_models(self, provider_id: str) -> list[ModelRow]:
        with self._connect() as conn:
            rows = conn.execute(
                """UPDATE platform_model AS m SET status='published',version=version+1,updated_at=now()
                   WHERE m.provider_id=%s::uuid AND m.status <> 'published'
                     AND EXISTS (
                       SELECT 1 FROM platform_model_rate AS r
                       WHERE r.provider_id=m.provider_id AND r.model_id=m.model_id
                         AND r.effective_to IS NULL AND r.pricing_status='known'
                     )
                   RETURNING m.provider_id::text,m.model_id,m.display_name,m.capabilities,m.status,m.source,m.version,m.updated_at""",
                (provider_id,),
            ).fetchall()
        return [self._model(row) for row in rows]

    def create_rate(self, provider_id: str, model_id: str, **values) -> RateRow:
        with self._connect() as conn:
            with conn.transaction():
                conn.execute(
                    "SELECT 1 FROM platform_model WHERE provider_id=%s::uuid AND model_id=%s FOR UPDATE",
                    (provider_id, model_id),
                ).fetchone()
                current = conn.execute(
                    "SELECT COALESCE(MAX(pricing_version),0) FROM platform_model_rate WHERE provider_id=%s::uuid AND model_id=%s",
                    (provider_id, model_id),
                ).fetchone()
                version = int(current["coalesce"]) + 1
                conn.execute(
                    "UPDATE platform_model_rate SET effective_to=%s WHERE provider_id=%s::uuid AND model_id=%s AND effective_to IS NULL",
                    (values["effective_from"], provider_id, model_id),
                )
                row = conn.execute(
                    """INSERT INTO platform_model_rate
                       (provider_id,model_id,pricing_version,pricing_status,billing_mode,input_usd_per_million,output_usd_per_million,
                        cache_read_usd_per_million,cache_write_usd_per_million,request_usd,source,source_version,effective_from,manually_overridden)
                       VALUES (%s::uuid,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       RETURNING rate_id::text,provider_id::text,model_id,pricing_version,pricing_status,billing_mode,input_usd_per_million,
                        output_usd_per_million,cache_read_usd_per_million,cache_write_usd_per_million,request_usd,currency,source,source_version,
                        effective_from,effective_to,manually_overridden""",
                    (provider_id, model_id, version, values["pricing_status"], values["billing_mode"], values.get("input_usd_per_million"),
                     values.get("output_usd_per_million"), values.get("cache_read_usd_per_million"), values.get("cache_write_usd_per_million"),
                     values.get("request_usd"), values["source"], values.get("source_version"), values["effective_from"], values["manually_overridden"]),
                ).fetchone()
        return self._rate(row)

    def current_rate(self, provider_id: str, model_id: str) -> RateRow | None:
        with self._connect() as conn:
            row = conn.execute(
                """SELECT rate_id::text,provider_id::text,model_id,pricing_version,pricing_status,billing_mode,input_usd_per_million,
                   output_usd_per_million,cache_read_usd_per_million,cache_write_usd_per_million,request_usd,currency,source,source_version,
                   effective_from,effective_to,manually_overridden FROM platform_model_rate
                   WHERE provider_id=%s::uuid AND model_id=%s AND effective_to IS NULL""",
                (provider_id, model_id),
            ).fetchone()
        return self._rate(row) if row else None

    def upsert_access(self, *, tenant_id: str, provider_id: str, encrypted_token: bytes, encrypted_management_token: bytes, allowed_model_ids: list[str], newapi_username: str, newapi_user_id: int | None, newapi_token_id: int | None, expires_at: datetime | None) -> AccessRow:
        import json
        with self._connect() as conn:
            row = conn.execute(
                """INSERT INTO platform_provider_tenant_access
                   (tenant_id,provider_id,encrypted_token,encrypted_management_token,allowed_model_ids,newapi_username,newapi_user_id,newapi_token_id,expires_at)
                   VALUES (%s::uuid,%s::uuid,%s,%s,%s::jsonb,%s,%s,%s,%s)
                   ON CONFLICT (tenant_id,provider_id) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,
                     encrypted_management_token=EXCLUDED.encrypted_management_token,allowed_model_ids=EXCLUDED.allowed_model_ids,
                     newapi_username=EXCLUDED.newapi_username,newapi_user_id=EXCLUDED.newapi_user_id,newapi_token_id=EXCLUDED.newapi_token_id,
                     expires_at=EXCLUDED.expires_at,status='active',version=platform_provider_tenant_access.version+1,updated_at=now()
                   RETURNING access_id::text,tenant_id::text,provider_id::text,encrypted_token,encrypted_management_token,allowed_model_ids,
                     newapi_username,newapi_user_id,newapi_token_id,status,version,expires_at""",
                (tenant_id, provider_id, encrypted_token, encrypted_management_token, json.dumps(allowed_model_ids), newapi_username, newapi_user_id, newapi_token_id, expires_at),
            ).fetchone()
        data = dict(row)
        data["encrypted_token"] = bytes(data["encrypted_token"])
        data["encrypted_management_token"] = bytes(data["encrypted_management_token"])
        data["allowed_model_ids"] = list(data["allowed_model_ids"])
        return AccessRow(**data)

    def get_access(self, tenant_id: str, provider_id: str) -> AccessRow | None:
        with self._connect() as conn:
            row = conn.execute(
                """SELECT access_id::text,tenant_id::text,provider_id::text,encrypted_token,encrypted_management_token,allowed_model_ids,
                   newapi_username,newapi_user_id,newapi_token_id,status,version,expires_at
                   FROM platform_provider_tenant_access WHERE tenant_id=%s::uuid AND provider_id=%s::uuid""",
                (tenant_id, provider_id),
            ).fetchone()
        if not row:
            return None
        data = dict(row)
        data["encrypted_token"] = bytes(data["encrypted_token"])
        data["encrypted_management_token"] = bytes(data["encrypted_management_token"])
        data["allowed_model_ids"] = list(data["allowed_model_ids"])
        return AccessRow(**data)
