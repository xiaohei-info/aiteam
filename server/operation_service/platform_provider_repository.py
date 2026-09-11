"""PostgreSQL repository for Operator-owned platform Provider truth (D18)."""
from __future__ import annotations

import json
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
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
    # A deterministic digest of the effective Operator model policy.  Empty
    # means the row predates policy provenance and must not be treated as proof
    # that an unbounded access grant is still current.
    policy_revision: str = ""
    encrypted_bootstrap_password: bytes | None = None


@dataclass(frozen=True)
class RelayTokenLifecycleRow:
    """Durable, non-secret record for every NewAPI token known to Operator."""

    lifecycle_id: str
    tenant_id: str
    provider_id: str
    newapi_user_id: int | None
    newapi_token_id: int
    token_name: str
    allowed_model_ids: list[str]
    expires_at: datetime | None
    policy_revision: str
    status: str
    revoked_at: datetime | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class RelayTokenOperationRow:
    """Durable receipt for an upstream lifecycle operation.

    The row is intentionally secret-free.  ``operation_key`` is the stable
    idempotency key used when a request is retried after an unknown HTTP
    outcome; ``attempt_count`` and ``lease_until`` make recovery safe across
    process restarts.  Create-state fields distinguish an unstarted write
    from an uncertain write that must be reconciled without another POST.
    """

    operation_id: str
    tenant_id: str
    provider_id: str
    newapi_user_id: int | None
    newapi_token_id: int | None
    token_name: str
    operation_type: str
    operation_key: str
    desired_model_ids: list[str]
    desired_expires_at: datetime | None
    policy_revision: str
    status: str
    attempt_count: int
    next_attempt_at: datetime | None
    lease_until: datetime | None
    last_error: str | None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None
    expected_access_version: int | None = None
    expected_access_token_id: int | None = None
    bootstrap_state: str = "planned"
    quota_before: int | None = None
    quota_delta: int | None = None
    claim_owner: str | None = None
    create_attempt_state: str = "not_started"
    user_create_state: str = "not_started"

    @property
    def operation(self) -> str:
        """Compatibility spelling for callers that use ``operation``."""
        return self.operation_type


# Keep the names easy to discover for provider lifecycle callers.
RelayTokenRecord = RelayTokenLifecycleRow
RelayTokenOperation = RelayTokenOperationRow


class PlatformProviderRepository:
    def __init__(self, dsn: str):
        self._dsn = dsn

    def _connect(self):
        return psycopg.connect(self._dsn, autocommit=True, row_factory=dict_row)

    @contextmanager
    def relay_access_lock(self, tenant_id: str, provider_id: str):
        """Hold a transaction-scoped lock for one tenant/provider resolver."""
        # hashtextextended is deterministic across processes and avoids the
        # 32-bit collision surface of hashtext for the durable writer fence.
        with self._connect() as conn:
            with conn.transaction():
                conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                    (f"relay-access:{tenant_id}:{provider_id}",),
                )
                yield

    @staticmethod
    def _provider(row) -> ProviderRow:
        return ProviderRow(**dict(row))

    @staticmethod
    def _model(row) -> ModelRow:
        data = dict(row)
        data["capabilities"] = dict(data.get("capabilities") or {})
        return ModelRow(**data)

    @staticmethod
    def _rate(row) -> RateRow:
        return RateRow(**dict(row))

    @staticmethod
    def _access_data(row) -> dict[str, Any]:
        data = dict(row)
        data["encrypted_token"] = bytes(data["encrypted_token"])
        data["encrypted_management_token"] = bytes(data["encrypted_management_token"])
        data["allowed_model_ids"] = list(data.get("allowed_model_ids") or [])
        if data.get("encrypted_bootstrap_password") is not None:
            data["encrypted_bootstrap_password"] = bytes(data["encrypted_bootstrap_password"])
        else:
            data["encrypted_bootstrap_password"] = None
        # The default keeps lightweight repository fakes and rows created by
        # pre-lifecycle deployments readable while the migration is rolling
        # out.  Such rows are deliberately treated as provenance-unknown by
        # the service rather than as an unbounded grant.
        data.setdefault("policy_revision", "")
        return data

    @staticmethod
    def _relay_token(row) -> RelayTokenLifecycleRow:
        data = dict(row)
        data["allowed_model_ids"] = list(data.get("allowed_model_ids") or [])
        return RelayTokenLifecycleRow(**data)

    @staticmethod
    def _relay_operation(row) -> RelayTokenOperationRow:
        data = dict(row)
        data["desired_model_ids"] = list(data.get("desired_model_ids") or [])
        data.setdefault("expected_access_version", None)
        data.setdefault("expected_access_token_id", None)
        data.setdefault("bootstrap_state", "planned")
        data.setdefault("quota_before", None)
        data.setdefault("quota_delta", None)
        data.setdefault("claim_owner", None)
        data.setdefault("create_attempt_state", "not_started")
        data.setdefault("user_create_state", "not_started")
        return RelayTokenOperationRow(**data)

    def ensure_internal_provider(self, *, provider_code: str, display_name: str, relay_base_url: str, api_protocol: str, newapi_channel_id: int) -> ProviderRow:
        """Return the single deployment-owned NewAPI provider projection."""
        with self._connect() as conn:
            row = conn.execute(
                """INSERT INTO platform_provider (provider_code,display_name,relay_base_url,api_protocol,newapi_channel_id,status)
                   VALUES (%s,%s,%s,%s,%s,'published')
                   ON CONFLICT (provider_code) DO UPDATE SET
                     display_name=EXCLUDED.display_name,
                     relay_base_url=EXCLUDED.relay_base_url,
                     api_protocol=EXCLUDED.api_protocol,
                     newapi_channel_id=EXCLUDED.newapi_channel_id,
                     status='published',
                     -- Reconciliation is not a release. Relay URL/channel
                     -- changes must not invalidate stable employee references.
                     version=platform_provider.version,
                     updated_at=now()
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
                           ON CONFLICT (provider_id,model_id) DO UPDATE SET
                             status=CASE WHEN platform_model.status='disabled' THEN 'draft' ELSE platform_model.status END,
                             version=CASE WHEN platform_model.status='disabled' THEN platform_model.version+1 ELSE platform_model.version END,
                             updated_at=now()""",
                        (provider_id, model_id),
                    )
                conn.execute(
                    """UPDATE platform_model SET status='disabled',version=version+1,updated_at=now()
                       WHERE provider_id=%s::uuid AND source='discovery' AND status <> 'disabled'
                         AND NOT (model_id = ANY(%s))""",
                    (provider_id, model_ids),
                )
                rows = conn.execute(
                    """SELECT provider_id::text,model_id,display_name,capabilities,status,source,version,updated_at
                       FROM platform_model WHERE provider_id=%s::uuid AND status <> 'disabled' ORDER BY model_id""",
                    (provider_id,),
                ).fetchall()
        return [self._model(row) for row in rows]

    def update_model_metadata(
        self,
        provider_id: str,
        model_id: str,
        *,
        display_name: str | None,
        capabilities: dict[str, Any],
    ) -> ModelRow | None:
        """Fill one discovered model's non-sensitive metadata without invalidating pinned refs."""
        if not capabilities:
            return self.get_model(provider_id, model_id)
        with self._connect() as conn:
            row = conn.execute(
                """UPDATE platform_model SET
                       display_name = CASE WHEN COALESCE(display_name, '') = '' THEN %s ELSE display_name END,
                       capabilities = %s::jsonb,
                       updated_at = now()
                   WHERE provider_id=%s::uuid AND model_id=%s
                     AND (
                       COALESCE(capabilities, '{}'::jsonb) = '{}'::jsonb
                       OR NOT (capabilities ? 'thinking_levels')
                       OR NOT (capabilities ? 'thinking_mode')
                     )
                   RETURNING provider_id::text,model_id,display_name,capabilities,status,source,version,updated_at""",
                (display_name or "", json.dumps(capabilities), provider_id, model_id),
            ).fetchone()
        return self._model(row) if row else None

    def list_models(self, provider_id: str, *, published_only: bool = False) -> list[ModelRow]:
        suffix = " AND status='published'" if published_only else " AND status <> 'disabled'"
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
                   WHERE m.provider_id=%s::uuid AND m.status NOT IN ('published','disabled')
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

    @staticmethod
    def _access_returning() -> str:
        return (
            "access_id::text,tenant_id::text,provider_id::text,encrypted_token,"
            "encrypted_management_token,allowed_model_ids,newapi_username,newapi_user_id,"
            "newapi_token_id,status,version,expires_at,encrypted_bootstrap_password,policy_revision"
        )

    def _upsert_access_on_connection(
        self,
        conn,
        *,
        tenant_id: str,
        provider_id: str,
        encrypted_token: bytes,
        encrypted_management_token: bytes,
        allowed_model_ids: list[str],
        newapi_username: str,
        newapi_user_id: int | None,
        newapi_token_id: int | None,
        expires_at: datetime | None,
        policy_revision: str,
        expected_version: int | None = None,
        expected_token_id: int | None = None,
        expected_policy_revision: str | None = None,
    ) -> AccessRow:
        conflict_predicates: list[str] = []
        conflict_params: list[Any] = []
        if expected_version is not None:
            current = conn.execute(
                """SELECT version,newapi_token_id,policy_revision
                   FROM platform_provider_tenant_access
                   WHERE tenant_id=%s::uuid AND provider_id=%s::uuid
                   FOR UPDATE""",
                (tenant_id, provider_id),
            ).fetchone()
            if expected_version == 0:
                if current is not None:
                    raise RuntimeError("relay access upsert returned no row")
            elif (
                current is None
                or int(current["version"]) != expected_version
                or current["newapi_token_id"] != expected_token_id
                or (
                    expected_policy_revision is not None
                    and current["policy_revision"] != expected_policy_revision
                )
            ):
                raise RuntimeError("relay access upsert returned no row")
            conflict_predicates.append("platform_provider_tenant_access.version=%s")
            conflict_params.append(expected_version)
            if expected_token_id is None:
                conflict_predicates.append("platform_provider_tenant_access.newapi_token_id IS NULL")
            else:
                conflict_predicates.append("platform_provider_tenant_access.newapi_token_id=%s")
                conflict_params.append(expected_token_id)
            if expected_policy_revision is not None:
                conflict_predicates.append("platform_provider_tenant_access.policy_revision=%s")
                conflict_params.append(expected_policy_revision)
        conflict_where = (
            " WHERE " + " AND ".join(conflict_predicates)
            if conflict_predicates else ""
        )
        row = conn.execute(
            f"""INSERT INTO platform_provider_tenant_access
                   (tenant_id,provider_id,encrypted_token,encrypted_management_token,allowed_model_ids,
                    newapi_username,newapi_user_id,newapi_token_id,expires_at,policy_revision)
                   VALUES (%s::uuid,%s::uuid,%s,%s,%s::jsonb,%s,%s,%s,%s,%s)
                   ON CONFLICT (tenant_id,provider_id) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,
                     encrypted_management_token=EXCLUDED.encrypted_management_token,allowed_model_ids=EXCLUDED.allowed_model_ids,
                     newapi_username=EXCLUDED.newapi_username,newapi_user_id=EXCLUDED.newapi_user_id,newapi_token_id=EXCLUDED.newapi_token_id,
                     expires_at=EXCLUDED.expires_at,policy_revision=EXCLUDED.policy_revision,status='active',
                     version=platform_provider_tenant_access.version+1,updated_at=now()
                   {conflict_where}
                   RETURNING {self._access_returning()}""",
            (
                tenant_id,
                provider_id,
                encrypted_token,
                encrypted_management_token,
                json.dumps(allowed_model_ids),
                newapi_username,
                newapi_user_id,
                newapi_token_id,
                expires_at,
                policy_revision,
                *conflict_params,
            ),
        ).fetchone()
        if row is None:
            raise RuntimeError("relay access upsert returned no row")
        return AccessRow(**self._access_data(row))

    def upsert_access(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        encrypted_token: bytes,
        encrypted_management_token: bytes,
        allowed_model_ids: list[str],
        newapi_username: str,
        newapi_user_id: int | None,
        newapi_token_id: int | None,
        expires_at: datetime | None,
        policy_revision: str = "",
        expected_version: int | None = None,
        expected_token_id: int | None = None,
        expected_policy_revision: str | None = None,
    ) -> AccessRow:
        with self._connect() as conn:
            return self._upsert_access_on_connection(
                conn,
                tenant_id=tenant_id,
                provider_id=provider_id,
                encrypted_token=encrypted_token,
                encrypted_management_token=encrypted_management_token,
                allowed_model_ids=allowed_model_ids,
                newapi_username=newapi_username,
                newapi_user_id=newapi_user_id,
                newapi_token_id=newapi_token_id,
                expires_at=expires_at,
                policy_revision=policy_revision,
                expected_version=expected_version,
                expected_token_id=expected_token_id,
                expected_policy_revision=expected_policy_revision,
            )

    def _stage_relay_access_on_connection(
        self,
        conn,
        *,
        tenant_id: str,
        provider_id: str,
        encrypted_management_token: bytes,
        encrypted_bootstrap_password: bytes | None,
        allowed_model_ids: list[str],
        newapi_username: str,
        newapi_user_id: int | None,
        policy_revision: str,
        encrypted_token: bytes | None,
    ) -> AccessRow:
        row = conn.execute(
            f"""INSERT INTO platform_provider_tenant_access
                   (tenant_id,provider_id,encrypted_token,encrypted_management_token,encrypted_bootstrap_password,
                    allowed_model_ids,newapi_username,newapi_user_id,newapi_token_id,status,expires_at,policy_revision)
                   VALUES (%s::uuid,%s::uuid,%s,%s,%s,%s::jsonb,%s,%s,NULL,'revoked',NULL,%s)
                   ON CONFLICT (tenant_id,provider_id) DO UPDATE SET
                     encrypted_management_token=CASE WHEN platform_provider_tenant_access.status='active'
                                                     THEN platform_provider_tenant_access.encrypted_management_token
                                                     ELSE EXCLUDED.encrypted_management_token END,
                     encrypted_bootstrap_password=CASE WHEN platform_provider_tenant_access.status='active'
                                                       THEN platform_provider_tenant_access.encrypted_bootstrap_password
                                                       ELSE EXCLUDED.encrypted_bootstrap_password END,
                     allowed_model_ids=EXCLUDED.allowed_model_ids,
                     newapi_username=EXCLUDED.newapi_username,
                     newapi_user_id=CASE WHEN platform_provider_tenant_access.status='active'
                                         THEN platform_provider_tenant_access.newapi_user_id
                                         ELSE EXCLUDED.newapi_user_id END,
                     status=CASE WHEN platform_provider_tenant_access.status='active' THEN platform_provider_tenant_access.status ELSE 'revoked' END,
                     policy_revision=EXCLUDED.policy_revision,
                     version=CASE WHEN platform_provider_tenant_access.status='active'
                                  THEN platform_provider_tenant_access.version
                                  WHEN platform_provider_tenant_access.newapi_token_id IS NULL
                                  THEN platform_provider_tenant_access.version
                                  ELSE platform_provider_tenant_access.version+1 END,
                     updated_at=now()
                   RETURNING {self._access_returning()}""",
            (
                tenant_id,
                provider_id,
                encrypted_token if encrypted_token is not None else self._empty_encrypted_token(),
                encrypted_management_token,
                encrypted_bootstrap_password,
                json.dumps(allowed_model_ids),
                newapi_username,
                newapi_user_id,
                policy_revision,
            ),
        ).fetchone()
        if row is None:
            raise RuntimeError("relay access staging returned no row")
        return AccessRow(**self._access_data(row))

    def stage_relay_access(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        encrypted_management_token: bytes,
        allowed_model_ids: list[str],
        newapi_username: str,
        newapi_user_id: int | None,
        policy_revision: str = "",
        encrypted_token: bytes | None = None,
        encrypted_bootstrap_password: bytes | None = None,
    ) -> AccessRow:
        """Persist enough non-runtime state to recover an initial issue."""
        with self._connect() as conn:
            return self._stage_relay_access_on_connection(
                conn,
                tenant_id=tenant_id,
                provider_id=provider_id,
                encrypted_management_token=encrypted_management_token,
                encrypted_bootstrap_password=encrypted_bootstrap_password,
                allowed_model_ids=allowed_model_ids,
                newapi_username=newapi_username,
                newapi_user_id=newapi_user_id,
                policy_revision=policy_revision,
                encrypted_token=encrypted_token,
            )

    def stage_relay_access_with_operation(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        encrypted_management_token: bytes,
        encrypted_bootstrap_password: bytes,
        allowed_model_ids: list[str],
        newapi_username: str,
        policy_revision: str,
        operation_key: str,
        expires_at: datetime,
        encrypted_token: bytes | None = None,
    ) -> tuple[AccessRow, RelayTokenOperationRow]:
        """Atomically persist a bootstrap receipt before NewAPI writes."""
        with self._connect() as conn:
            with conn.transaction():
                access = self._stage_relay_access_on_connection(
                    conn,
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    encrypted_management_token=encrypted_management_token,
                    encrypted_bootstrap_password=encrypted_bootstrap_password,
                    allowed_model_ids=allowed_model_ids,
                    newapi_username=newapi_username,
                    newapi_user_id=None,
                    policy_revision=policy_revision,
                    encrypted_token=encrypted_token,
                )
                operation = self._record_relay_token_operation_on_connection(
                    conn,
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    newapi_user_id=None,
                    newapi_token_id=None,
                    token_name=newapi_username,
                    operation_type="bootstrap",
                    operation_key=operation_key,
                    desired_model_ids=allowed_model_ids,
                    desired_expires_at=expires_at,
                    policy_revision=policy_revision,
                    expected_access_version=access.version,
                    expected_access_token_id=None,
                )
        return access, operation

    def set_relay_bootstrap_identity(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        newapi_user_id: int,
    ) -> AccessRow | None:
        """Persist the observed NewAPI user id without activating access."""
        with self._connect() as conn:
            row = conn.execute(
                f"""UPDATE platform_provider_tenant_access
                       SET newapi_user_id=%s,updated_at=now()
                     WHERE tenant_id=%s::uuid AND provider_id=%s::uuid
                       AND status='revoked' AND newapi_token_id IS NULL
                     RETURNING {self._access_returning()}""",
                (newapi_user_id, tenant_id, provider_id),
            ).fetchone()
        return AccessRow(**self._access_data(row)) if row else None

    def complete_relay_bootstrap(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        newapi_user_id: int,
        encrypted_management_token: bytes,
    ) -> AccessRow | None:
        """Persist the management token and clear the one-shot password."""
        with self._connect() as conn:
            row = conn.execute(
                f"""UPDATE platform_provider_tenant_access
                       SET newapi_user_id=%s,encrypted_management_token=%s,
                           encrypted_bootstrap_password=NULL,status='revoked',updated_at=now()
                     WHERE tenant_id=%s::uuid AND provider_id=%s::uuid
                       AND status='revoked' AND newapi_token_id IS NULL
                     RETURNING {self._access_returning()}""",
                (newapi_user_id, encrypted_management_token, tenant_id, provider_id),
            ).fetchone()
        return AccessRow(**self._access_data(row)) if row else None

    @staticmethod
    def _empty_encrypted_token() -> bytes:
        # This value is only a storage placeholder.  Runtime access checks
        # reject the revoked row before attempting to decrypt it.
        return b""

    @staticmethod
    def _cancel_relay_token_revoke_on_connection(
        conn,
        *,
        tenant_id: str,
        provider_id: str,
        newapi_token_id: int,
        exclude_operation_id: str | None = None,
    ) -> int:
        """Cancel a pending safety revoke before adopting its token locally."""
        exclude_clause = " AND operation_id <> %s::uuid" if exclude_operation_id is not None else ""
        select_params: tuple[Any, ...] = (
            tenant_id, provider_id, newapi_token_id, exclude_operation_id,
        ) if exclude_operation_id is not None else (
            tenant_id, provider_id, newapi_token_id,
        )
        matching = conn.execute(
            f"""SELECT operation_id,status,lease_until,
                          (status='running' AND lease_until IS NOT NULL AND lease_until > now()) AS lease_live
                 FROM platform_provider_relay_token_operation
                WHERE tenant_id=%s::uuid AND provider_id=%s::uuid
                  AND newapi_token_id=%s
                  AND operation_type IN ('revoke','delete'){exclude_clause}
                FOR UPDATE""",
            select_params,
        ).fetchall()
        if any(row["lease_live"] for row in matching):
            raise RuntimeError("relay token adoption is blocked by a live safety revoke")
        rows = conn.execute(
            f"""UPDATE platform_provider_relay_token_operation
                  SET status='succeeded',next_attempt_at=NULL,lease_until=NULL,
                      claim_owner=NULL,last_error='cancelled: token adopted as current active access',
                      completed_at=COALESCE(completed_at,now()),updated_at=now()
                WHERE tenant_id=%s::uuid AND provider_id=%s::uuid
                  AND newapi_token_id=%s
                  AND operation_type IN ('revoke','delete'){exclude_clause}
                  AND (
                    status IN ('pending','failed')
                    OR (status='running' AND (lease_until IS NULL OR lease_until <= now()))
                  )
                RETURNING operation_id""",
            select_params,
        ).fetchall()
        return len(rows)

    def cancel_relay_token_revoke_on_adoption(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        newapi_token_id: int,
        exclude_operation_id: str | None = None,
    ) -> int:
        """Cancel pending safety cleanup for a token becoming current."""
        with self._connect() as conn:
            with conn.transaction():
                return self._cancel_relay_token_revoke_on_connection(
                    conn,
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    newapi_token_id=newapi_token_id,
                    exclude_operation_id=exclude_operation_id,
                )

    def upsert_access_with_relay_token(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        encrypted_token: bytes,
        encrypted_management_token: bytes,
        allowed_model_ids: list[str],
        newapi_username: str,
        newapi_user_id: int | None,
        newapi_token_id: int,
        expires_at: datetime | None,
        policy_revision: str,
        token_name: str,
        old_token_id: int | None = None,
        old_token_user_id: int | None = None,
        old_operation_key: str | None = None,
        old_token_name: str = "",
        old_desired_model_ids: list[str] | None = None,
        old_desired_expires_at: datetime | None = None,
        old_policy_revision: str = "",
        expected_version: int | None = None,
        expected_token_id: int | None = None,
        expected_policy_revision: str | None = None,
        operation_id: str | None = None,
        claim_owner: str | None = None,
    ) -> AccessRow:
        """Commit access only while the issuing receipt's lease is owned.

        The upstream call necessarily happens outside this transaction.  Once
        it succeeds, however, a crash cannot leave a new token active locally
        without a durable lifecycle record.  When a claim is supplied, the
        owner and PostgreSQL ``now()`` lease check happen in this same
        transaction immediately before the access CAS, so a worker that lost
        a lease cannot publish after takeover.
        """
        with self._connect() as conn:
            with conn.transaction():
                if operation_id is not None:
                    if claim_owner is None:
                        raise RuntimeError("relay lifecycle access commit owner is unavailable")
                    claim = conn.execute(
                        """SELECT operation_id
                             FROM platform_provider_relay_token_operation
                            WHERE operation_id=%s::uuid
                              AND status='running'
                              AND claim_owner=%s
                              AND lease_until IS NOT NULL
                              AND lease_until > now()
                            FOR UPDATE""",
                        (operation_id, claim_owner),
                    ).fetchone()
                    if claim is None:
                        raise RuntimeError("relay lifecycle access commit claim is stale")
                self._cancel_relay_token_revoke_on_connection(
                    conn,
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    newapi_token_id=newapi_token_id,
                )
                access = self._upsert_access_on_connection(
                    conn,
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    encrypted_token=encrypted_token,
                    encrypted_management_token=encrypted_management_token,
                    allowed_model_ids=allowed_model_ids,
                    newapi_username=newapi_username,
                    newapi_user_id=newapi_user_id,
                    newapi_token_id=newapi_token_id,
                    expires_at=expires_at,
                    policy_revision=policy_revision,
                    expected_version=expected_version,
                    expected_token_id=expected_token_id,
                    expected_policy_revision=expected_policy_revision,
                )
                self._record_relay_token_on_connection(
                    conn,
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    newapi_user_id=newapi_user_id,
                    newapi_token_id=newapi_token_id,
                    token_name=token_name,
                    allowed_model_ids=allowed_model_ids,
                    expires_at=expires_at,
                    policy_revision=policy_revision,
                )
                if old_token_id is not None and old_operation_key:
                    self._record_relay_token_operation_on_connection(
                        conn,
                        tenant_id=tenant_id,
                        provider_id=provider_id,
                        newapi_user_id=old_token_user_id,
                        newapi_token_id=old_token_id,
                        token_name=old_token_name,
                        operation_type="revoke",
                        operation_key=old_operation_key,
                        desired_model_ids=old_desired_model_ids or [],
                        desired_expires_at=old_desired_expires_at,
                        policy_revision=old_policy_revision,
                        expected_access_version=expected_version,
                        expected_access_token_id=expected_token_id,
                    )
        return access

    def get_access(self, tenant_id: str, provider_id: str) -> AccessRow | None:
        with self._connect() as conn:
            row = conn.execute(
                f"""SELECT {self._access_returning()}
                   FROM platform_provider_tenant_access WHERE tenant_id=%s::uuid AND provider_id=%s::uuid""",
                (tenant_id, provider_id),
            ).fetchone()
        if not row:
            return None
        return AccessRow(**self._access_data(row))

    def mark_access_revoked(
        self,
        tenant_id: str,
        provider_id: str,
        *,
        expected_token_id: int | None = None,
    ) -> AccessRow | None:
        """Invalidate the local projection without destroying encrypted data.

        ``expected_token_id`` is a CAS fence: revoking an old token after a
        replacement was committed must never mark the replacement revoked.
        """
        predicates = ["tenant_id=%s::uuid", "provider_id=%s::uuid", "status <> 'revoked'"]
        params: list[Any] = [tenant_id, provider_id]
        if expected_token_id is not None:
            predicates.append("newapi_token_id=%s")
            params.append(expected_token_id)
        with self._connect() as conn:
            row = conn.execute(
                f"""UPDATE platform_provider_tenant_access
                       SET status='revoked',version=version+1,updated_at=now()
                       WHERE {' AND '.join(predicates)}
                       RETURNING {self._access_returning()}""",
                tuple(params),
            ).fetchone()
        if row:
            return AccessRow(**self._access_data(row))
        return self.get_access(tenant_id, provider_id)

    def bump_relay_access_generation(
        self,
        tenant_id: str,
        provider_id: str,
        *,
        expected_token_id: int,
    ) -> AccessRow | None:
        """Advance the local name generation after fencing an orphan token."""
        with self._connect() as conn:
            row = conn.execute(
                f"""UPDATE platform_provider_tenant_access
                       SET version=version+1,updated_at=now()
                     WHERE tenant_id=%s::uuid AND provider_id=%s::uuid
                       AND newapi_token_id IS DISTINCT FROM %s
                     RETURNING {self._access_returning()}""",
                (tenant_id, provider_id, expected_token_id),
            ).fetchone()
        return AccessRow(**self._access_data(row)) if row else None

    def _record_relay_token_on_connection(
        self,
        conn,
        *,
        tenant_id: str,
        provider_id: str,
        newapi_user_id: int | None,
        newapi_token_id: int,
        token_name: str,
        allowed_model_ids: list[str],
        expires_at: datetime | None,
        policy_revision: str,
        status: str = "active",
    ) -> RelayTokenLifecycleRow:
        row = conn.execute(
            """INSERT INTO platform_provider_relay_token
                   (tenant_id,provider_id,newapi_user_id,newapi_token_id,token_name,
                    allowed_model_ids,expires_at,policy_revision,status)
                   VALUES (%s::uuid,%s::uuid,%s,%s,%s,%s::jsonb,%s,%s,%s)
                   ON CONFLICT (tenant_id,provider_id,newapi_token_id) DO UPDATE SET
                     newapi_user_id=EXCLUDED.newapi_user_id,
                     token_name=CASE WHEN platform_provider_relay_token.token_name='' THEN EXCLUDED.token_name ELSE platform_provider_relay_token.token_name END,
                     allowed_model_ids=CASE WHEN platform_provider_relay_token.status='revoked' THEN platform_provider_relay_token.allowed_model_ids ELSE EXCLUDED.allowed_model_ids END,
                     expires_at=CASE WHEN platform_provider_relay_token.status='revoked' THEN platform_provider_relay_token.expires_at ELSE EXCLUDED.expires_at END,
                     policy_revision=CASE WHEN platform_provider_relay_token.status='revoked' THEN platform_provider_relay_token.policy_revision ELSE EXCLUDED.policy_revision END,
                     status=CASE WHEN platform_provider_relay_token.status='revoked' THEN 'revoked' ELSE EXCLUDED.status END,
                     updated_at=now()
                   RETURNING lifecycle_id::text,tenant_id::text,provider_id::text,newapi_user_id,newapi_token_id,
                     token_name,allowed_model_ids,expires_at,policy_revision,status,revoked_at,created_at,updated_at""",
            (
                tenant_id,
                provider_id,
                newapi_user_id,
                newapi_token_id,
                token_name,
                json.dumps(allowed_model_ids),
                expires_at,
                policy_revision,
                status,
            ),
        ).fetchone()
        if row is None:
            raise RuntimeError("relay token lifecycle insert returned no row")
        return self._relay_token(row)

    def record_relay_token(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        newapi_user_id: int | None,
        newapi_token_id: int,
        token_name: str,
        allowed_model_ids: list[str],
        expires_at: datetime | None,
        policy_revision: str = "",
        status: str = "active",
    ) -> RelayTokenLifecycleRow:
        with self._connect() as conn:
            return self._record_relay_token_on_connection(
                conn,
                tenant_id=tenant_id,
                provider_id=provider_id,
                newapi_user_id=newapi_user_id,
                newapi_token_id=newapi_token_id,
                token_name=token_name,
                allowed_model_ids=allowed_model_ids,
                expires_at=expires_at,
                policy_revision=policy_revision,
                status=status,
            )

    # Explicit alias for callers that prefer the table's full name.
    record_relay_token_lifecycle = record_relay_token

    def get_relay_token(self, tenant_id: str, provider_id: str, newapi_token_id: int) -> RelayTokenLifecycleRow | None:
        with self._connect() as conn:
            row = conn.execute(
                """SELECT lifecycle_id::text,tenant_id::text,provider_id::text,newapi_user_id,newapi_token_id,
                          token_name,allowed_model_ids,expires_at,policy_revision,status,revoked_at,created_at,updated_at
                   FROM platform_provider_relay_token
                   WHERE tenant_id=%s::uuid AND provider_id=%s::uuid AND newapi_token_id=%s""",
                (tenant_id, provider_id, newapi_token_id),
            ).fetchone()
        return self._relay_token(row) if row else None

    def list_relay_tokens(self, tenant_id: str | None = None, provider_id: str | None = None) -> list[RelayTokenLifecycleRow]:
        predicates: list[str] = []
        params: list[Any] = []
        if tenant_id is not None:
            predicates.append("tenant_id=%s::uuid")
            params.append(tenant_id)
        if provider_id is not None:
            predicates.append("provider_id=%s::uuid")
            params.append(provider_id)
        suffix = f" WHERE {' AND '.join(predicates)}" if predicates else ""
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT lifecycle_id::text,tenant_id::text,provider_id::text,newapi_user_id,newapi_token_id,
                          token_name,allowed_model_ids,expires_at,policy_revision,status,revoked_at,created_at,updated_at
                   FROM platform_provider_relay_token""" + suffix + " ORDER BY created_at",
                tuple(params),
            ).fetchall()
        return [self._relay_token(row) for row in rows]

    def mark_relay_token_revoked(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        newapi_token_id: int,
        observed: bool = True,
    ) -> RelayTokenLifecycleRow | None:
        with self._connect() as conn:
            row = conn.execute(
                """UPDATE platform_provider_relay_token
                   SET status='revoked',
                       revoked_at=CASE WHEN %s THEN COALESCE(revoked_at,now()) ELSE revoked_at END,
                       updated_at=now()
                   WHERE tenant_id=%s::uuid AND provider_id=%s::uuid AND newapi_token_id=%s
                   RETURNING lifecycle_id::text,tenant_id::text,provider_id::text,newapi_user_id,newapi_token_id,
                     token_name,allowed_model_ids,expires_at,policy_revision,status,revoked_at,created_at,updated_at""",
                (observed, tenant_id, provider_id, newapi_token_id),
            ).fetchone()
        return self._relay_token(row) if row else None

    def _operation_returning(self, prefix: str = "") -> str:
        qualifier = f"{prefix}." if prefix else ""
        return (
            f"{qualifier}operation_id::text,{qualifier}tenant_id::text,{qualifier}provider_id::text,"
            f"{qualifier}newapi_user_id,{qualifier}newapi_token_id,{qualifier}token_name,"
            f"{qualifier}operation_type,{qualifier}operation_key,{qualifier}desired_model_ids,"
            f"{qualifier}desired_expires_at,{qualifier}policy_revision,"
            f"{qualifier}expected_access_version,{qualifier}expected_access_token_id,"
            f"{qualifier}bootstrap_state,{qualifier}quota_before,{qualifier}quota_delta,"
            f"{qualifier}create_attempt_state,{qualifier}user_create_state,{qualifier}status,"
            f"{qualifier}attempt_count,{qualifier}next_attempt_at,{qualifier}lease_until,"
            f"{qualifier}claim_owner,{qualifier}last_error,{qualifier}created_at,"
            f"{qualifier}updated_at,{qualifier}completed_at"
        )

    def _record_relay_token_operation_on_connection(
        self,
        conn,
        *,
        tenant_id: str,
        provider_id: str,
        newapi_user_id: int | None,
        newapi_token_id: int | None,
        token_name: str,
        operation_type: str,
        operation_key: str,
        desired_model_ids: list[str],
        desired_expires_at: datetime | None,
        policy_revision: str,
        expected_access_version: int | None = None,
        expected_access_token_id: int | None = None,
    ) -> RelayTokenOperationRow:
        row = conn.execute(
            f"""INSERT INTO platform_provider_relay_token_operation
                   (tenant_id,provider_id,newapi_user_id,newapi_token_id,token_name,operation_type,
                    operation_key,desired_model_ids,desired_expires_at,policy_revision,
                    expected_access_version,expected_access_token_id,bootstrap_state,quota_before,quota_delta,
                    create_attempt_state,user_create_state,status,next_attempt_at)
                   VALUES (%s::uuid,%s::uuid,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,'planned',%s,%s,'not_started','not_started','pending',now())
                   ON CONFLICT (operation_key) DO UPDATE SET
                     desired_model_ids=EXCLUDED.desired_model_ids,
                     desired_expires_at=EXCLUDED.desired_expires_at,
                     policy_revision=EXCLUDED.policy_revision,
                     token_name=CASE WHEN platform_provider_relay_token_operation.token_name='' THEN EXCLUDED.token_name ELSE platform_provider_relay_token_operation.token_name END,
                     newapi_user_id=COALESCE(platform_provider_relay_token_operation.newapi_user_id,EXCLUDED.newapi_user_id),
                     newapi_token_id=COALESCE(platform_provider_relay_token_operation.newapi_token_id,EXCLUDED.newapi_token_id),
                     status=platform_provider_relay_token_operation.status,
                     next_attempt_at=platform_provider_relay_token_operation.next_attempt_at,
                     -- Keep the previous failure receipt for auditability;
                     -- a successful completion clears it explicitly below.
                     last_error=platform_provider_relay_token_operation.last_error,
                     updated_at=now()
                   WHERE platform_provider_relay_token_operation.tenant_id=EXCLUDED.tenant_id
                     AND platform_provider_relay_token_operation.provider_id=EXCLUDED.provider_id
                     AND platform_provider_relay_token_operation.operation_type=EXCLUDED.operation_type
                     AND (platform_provider_relay_token_operation.token_name=''
                          OR EXCLUDED.token_name=''
                          OR platform_provider_relay_token_operation.token_name=EXCLUDED.token_name)
                     AND (platform_provider_relay_token_operation.newapi_user_id IS NULL
                          OR EXCLUDED.newapi_user_id IS NULL
                          OR platform_provider_relay_token_operation.newapi_user_id=EXCLUDED.newapi_user_id)
                     AND (platform_provider_relay_token_operation.newapi_token_id IS NULL
                          OR EXCLUDED.newapi_token_id IS NULL
                          OR platform_provider_relay_token_operation.newapi_token_id=EXCLUDED.newapi_token_id)
                   RETURNING {self._operation_returning()}""",
            (
                tenant_id,
                provider_id,
                newapi_user_id,
                newapi_token_id,
                token_name,
                operation_type,
                operation_key,
                json.dumps(desired_model_ids),
                desired_expires_at,
                policy_revision,
                expected_access_version,
                expected_access_token_id,
                None,
                None,
            ),
        ).fetchone()
        if row is None:
            raise RuntimeError("relay token operation key conflicts with existing identity")
        return self._relay_operation(row)

    def ensure_relay_token_operation(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        newapi_user_id: int | None,
        newapi_token_id: int | None,
        token_name: str,
        operation_type: str,
        operation_key: str,
        desired_model_ids: list[str],
        desired_expires_at: datetime | None,
        policy_revision: str = "",
        expected_access_version: int | None = None,
        expected_access_token_id: int | None = None,
    ) -> RelayTokenOperationRow:
        with self._connect() as conn:
            return self._record_relay_token_operation_on_connection(
                conn,
                tenant_id=tenant_id,
                provider_id=provider_id,
                newapi_user_id=newapi_user_id,
                newapi_token_id=newapi_token_id,
                token_name=token_name,
                operation_type=operation_type,
                operation_key=operation_key,
                desired_model_ids=desired_model_ids,
                desired_expires_at=desired_expires_at,
                policy_revision=policy_revision,
                expected_access_version=expected_access_version,
                expected_access_token_id=expected_access_token_id,
            )

    # Alias retained for source discoverability and older test doubles.
    record_relay_token_operation = ensure_relay_token_operation

    def claim_relay_token_operation(
        self,
        operation_id: str,
        *,
        now: datetime | None = None,
        force: bool = False,
        claim_owner: str | None = None,
    ) -> RelayTokenOperationRow | None:
        """Claim one issue/revoke receipt so concurrent resolvers serialize."""
        now = now or datetime.now(UTC)
        if force:
            predicate = "status IN ('pending','failed') OR (status='running' AND (lease_until IS NULL OR lease_until <= %s))"
            params: tuple[Any, ...] = (now,)
        else:
            predicate = (
                "status='pending' OR "
                "(status='failed' AND (next_attempt_at IS NULL OR next_attempt_at <= %s)) OR "
                "(status='running' AND (lease_until IS NULL OR lease_until <= %s))"
            )
            params = (now, now)
        with self._connect() as conn:
            row = conn.execute(
                f"""UPDATE platform_provider_relay_token_operation
                       SET status='running',attempt_count=attempt_count+1,
                           lease_until=now()+interval '5 minutes',
                           claim_owner=COALESCE(%s,'operation-' || gen_random_uuid()::text),updated_at=now()
                     WHERE operation_id=%s::uuid AND ({predicate})
                     RETURNING {self._operation_returning()}""",
                (claim_owner, operation_id, now) if force else (claim_owner, operation_id, *params),
            ).fetchone()
        return self._relay_operation(row) if row else None

    def prepare_relay_token_revocation(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        expected_token_id: int,
        newapi_user_id: int | None,
        token_name: str,
        operation_key: str,
        desired_model_ids: list[str],
        desired_expires_at: datetime | None,
        policy_revision: str = "",
    ) -> tuple[AccessRow | None, RelayTokenOperationRow]:
        """Atomically fence local access and enqueue its upstream revoke."""
        with self._connect() as conn:
            with conn.transaction():
                row = conn.execute(
                    f"""UPDATE platform_provider_tenant_access
                           SET status='revoked',version=version+1,updated_at=now()
                           WHERE tenant_id=%s::uuid AND provider_id=%s::uuid
                             AND newapi_token_id=%s AND status <> 'revoked'
                           RETURNING {self._access_returning()}""",
                    (tenant_id, provider_id, expected_token_id),
                ).fetchone()
                access = AccessRow(**self._access_data(row)) if row else None
                operation = self._record_relay_token_operation_on_connection(
                    conn,
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    newapi_user_id=newapi_user_id,
                    newapi_token_id=expected_token_id,
                    token_name=token_name,
                    operation_type="revoke",
                    operation_key=operation_key,
                    desired_model_ids=desired_model_ids,
                    desired_expires_at=desired_expires_at,
                    policy_revision=policy_revision,
                )
        return access, operation

    def prepare_unidentified_relay_token_revocation(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        newapi_user_id: int | None,
        token_name: str,
        operation_key: str,
        desired_model_ids: list[str],
        desired_expires_at: datetime | None,
        policy_revision: str = "",
        expected_access_version: int | None = None,
    ) -> tuple[AccessRow | None, RelayTokenOperationRow]:
        """Atomically fence a legacy row and retain an ID-less revoke obligation."""
        with self._connect() as conn:
            with conn.transaction():
                row = conn.execute(
                    f"""UPDATE platform_provider_tenant_access
                           SET status='revoked',version=version+1,updated_at=now()
                           WHERE tenant_id=%s::uuid AND provider_id=%s::uuid
                             AND newapi_token_id IS NULL AND status <> 'revoked'
                           RETURNING {self._access_returning()}""",
                    (tenant_id, provider_id),
                ).fetchone()
                access = AccessRow(**self._access_data(row)) if row else None
                operation = self._record_relay_token_operation_on_connection(
                    conn,
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    newapi_user_id=newapi_user_id,
                    newapi_token_id=None,
                    token_name=token_name,
                    operation_type="revoke",
                    operation_key=operation_key,
                    desired_model_ids=desired_model_ids,
                    desired_expires_at=desired_expires_at,
                    policy_revision=policy_revision,
                    expected_access_version=expected_access_version,
                    expected_access_token_id=None,
                )
        return access, operation

    def get_relay_token_operation(self, operation_key: str) -> RelayTokenOperationRow | None:
        with self._connect() as conn:
            row = conn.execute(
                f"""SELECT {self._operation_returning()}
                   FROM platform_provider_relay_token_operation WHERE operation_key=%s""",
                (operation_key,),
            ).fetchone()
        return self._relay_operation(row) if row else None

    def list_relay_token_operations(
        self,
        *,
        tenant_id: str | None = None,
        provider_id: str | None = None,
    ) -> list[RelayTokenOperationRow]:
        predicates: list[str] = []
        params: list[Any] = []
        if tenant_id is not None:
            predicates.append("tenant_id=%s::uuid")
            params.append(tenant_id)
        if provider_id is not None:
            predicates.append("provider_id=%s::uuid")
            params.append(provider_id)
        suffix = f" WHERE {' AND '.join(predicates)}" if predicates else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"""SELECT {self._operation_returning()}
                   FROM platform_provider_relay_token_operation""" + suffix + " ORDER BY created_at",
                tuple(params),
            ).fetchall()
        return [self._relay_operation(row) for row in rows]

    def claim_relay_token_operations(
        self,
        *,
        limit: int = 100,
        now: datetime | None = None,
        force: bool = False,
        tenant_id: str | None = None,
        provider_id: str | None = None,
        claim_owner: str | None = None,
    ) -> list[RelayTokenOperationRow]:
        """Claim pending/failed receipts with one generated owner per row."""
        # ``claim_owner`` remains an additive compatibility argument for old
        # callers; batch claims intentionally ignore it so rows cannot share
        # an owner and accidentally complete one another's work.
        now = now or datetime.now(UTC)
        if force:
            # Explicit recovery bypasses backoff for pending/failed work, but
            # never steals a live worker's lease (issue operations remain
            # idempotent by name, yet concurrent ownership is still unsafe).
            due_condition = "(status IN ('pending','failed') OR (status='running' AND (lease_until IS NULL OR lease_until <= %s)))"
            params: list[Any] = [now]
        else:
            due_condition = (
                "(status IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= %s))"
                " OR (status='running' AND (lease_until IS NULL OR lease_until <= %s))"
            )
            params = [now, now]
        filters: list[str] = []
        if tenant_id is not None:
            filters.append("tenant_id=%s::uuid")
            params.append(tenant_id)
        if provider_id is not None:
            filters.append("provider_id=%s::uuid")
            params.append(provider_id)
        where = "(" + due_condition + ")" + (" AND " + " AND ".join(filters) if filters else "")
        params.append(limit)
        with self._connect() as conn:
            with conn.transaction():
                rows = conn.execute(
                    f"""WITH claimed AS (
                             SELECT operation_id
                             FROM platform_provider_relay_token_operation
                             WHERE {where}
                             ORDER BY COALESCE(next_attempt_at,created_at),created_at
                             LIMIT %s FOR UPDATE SKIP LOCKED
                         )
                         UPDATE platform_provider_relay_token_operation AS operation
                            SET status='running',attempt_count=operation.attempt_count+1,
                                lease_until=now()+interval '5 minutes',
                                claim_owner='operation-' || gen_random_uuid()::text,updated_at=now()
                           FROM claimed
                          WHERE operation.operation_id=claimed.operation_id
                         RETURNING """
                    + self._operation_returning("operation"),
                    tuple(params),
                ).fetchall()
        return [self._relay_operation(row) for row in rows]

    # Clearer name for recovery workers.
    claim_due_relay_token_operations = claim_relay_token_operations

    def mark_relay_token_operation_succeeded(
        self,
        operation_id: str,
        *,
        claim_owner: str | None = None,
    ) -> RelayTokenOperationRow | None:
        if claim_owner is None:
            return None
        owner_clause = " AND claim_owner=%s AND lease_until IS NOT NULL AND lease_until > now()"
        params: tuple[Any, ...] = (operation_id, claim_owner)
        with self._connect() as conn:
            row = conn.execute(
                f"""UPDATE platform_provider_relay_token_operation
                      SET status='succeeded',next_attempt_at=NULL,lease_until=NULL,claim_owner=NULL,last_error=NULL,
                          completed_at=COALESCE(completed_at,now()),updated_at=now()
                    WHERE operation_id=%s::uuid{owner_clause}
                    RETURNING {self._operation_returning()}""",
                params,
            ).fetchone()
        return self._relay_operation(row) if row else None

    def mark_relay_token_operation_failed(
        self,
        operation_id: str,
        *,
        error: str,
        next_attempt_at: datetime,
        increment_attempt: bool = True,
        claim_owner: str | None = None,
    ) -> RelayTokenOperationRow | None:
        if claim_owner is None:
            return None
        bounded = str(error).replace("\n", " ")[:500]
        owner_clause = " AND claim_owner=%s AND lease_until IS NOT NULL AND lease_until > now()"
        params: tuple[Any, ...] = (
            1 if increment_attempt else 0,
            next_attempt_at,
            bounded,
            operation_id,
            claim_owner,
        )
        with self._connect() as conn:
            row = conn.execute(
                f"""UPDATE platform_provider_relay_token_operation
                      SET status='failed',attempt_count=attempt_count+%s,next_attempt_at=%s,
                          lease_until=NULL,claim_owner=NULL,last_error=%s,updated_at=now()
                    WHERE operation_id=%s::uuid{owner_clause}
                    RETURNING {self._operation_returning()}""",
                params,
            ).fetchone()
        return self._relay_operation(row) if row else None

    def bind_relay_token_operation(
        self,
        operation_id: str,
        newapi_token_id: int,
        *,
        claim_owner: str | None = None,
    ) -> RelayTokenOperationRow | None:
        if claim_owner is None:
            return None
        owner_clause = " AND claim_owner=%s AND lease_until IS NOT NULL AND lease_until > now()"
        params: tuple[Any, ...] = (newapi_token_id, operation_id, claim_owner)
        with self._connect() as conn:
            row = conn.execute(
                f"""UPDATE platform_provider_relay_token_operation
                      SET newapi_token_id=COALESCE(newapi_token_id,%s),updated_at=now()
                    WHERE operation_id=%s::uuid{owner_clause}
                    RETURNING {self._operation_returning()}""",
                params,
            ).fetchone()
        return self._relay_operation(row) if row else None

    def update_relay_token_create_state(
        self,
        operation_id: str,
        *,
        create_attempt_state: str,
        claim_owner: str | None = None,
    ) -> RelayTokenOperationRow | None:
        """CAS-update create-attempt state before/after an upstream POST."""
        if claim_owner is None:
            return None
        owner_clause = " AND claim_owner=%s AND lease_until IS NOT NULL AND lease_until > now()"
        params: tuple[Any, ...] = (create_attempt_state, operation_id, claim_owner)
        with self._connect() as conn:
            row = conn.execute(
                f"""UPDATE platform_provider_relay_token_operation
                      SET create_attempt_state=%s,updated_at=now()
                    WHERE operation_id=%s::uuid{owner_clause}
                    RETURNING {self._operation_returning()}""",
                params,
            ).fetchone()
        return self._relay_operation(row) if row else None

    def update_relay_user_create_state(
        self,
        operation_id: str,
        *,
        user_create_state: str,
        newapi_user_id: int | None = None,
        claim_owner: str | None = None,
    ) -> RelayTokenOperationRow | None:
        """Persist exact-user create progress and the observed user ID."""
        if claim_owner is None:
            return None
        owner_clause = " AND claim_owner=%s AND lease_until IS NOT NULL AND lease_until > now()"
        params: tuple[Any, ...] = (user_create_state, newapi_user_id, operation_id, claim_owner)
        with self._connect() as conn:
            row = conn.execute(
                f"""UPDATE platform_provider_relay_token_operation
                      SET user_create_state=%s,newapi_user_id=COALESCE(%s,newapi_user_id),updated_at=now()
                    WHERE operation_id=%s::uuid{owner_clause}
                    RETURNING {self._operation_returning()}""",
                params,
            ).fetchone()
        return self._relay_operation(row) if row else None

    def update_relay_bootstrap_progress(
        self,
        operation_id: str,
        *,
        bootstrap_state: str,
        quota_before: int | None = None,
        quota_delta: int | None = None,
        claim_owner: str | None = None,
    ) -> RelayTokenOperationRow | None:
        """CAS-update bootstrap phase and quota baseline on its receipt."""
        if claim_owner is None:
            return None
        owner_clause = " AND claim_owner=%s AND lease_until IS NOT NULL AND lease_until > now()"
        params: tuple[Any, ...] = (
            bootstrap_state, quota_before, quota_delta, operation_id, claim_owner,
        )
        with self._connect() as conn:
            row = conn.execute(
                f"""UPDATE platform_provider_relay_token_operation
                      SET bootstrap_state=%s,quota_before=COALESCE(%s,quota_before),
                          quota_delta=COALESCE(%s,quota_delta),updated_at=now()
                    WHERE operation_id=%s::uuid{owner_clause}
                    RETURNING {self._operation_returning()}""",
                params,
            ).fetchone()
        return self._relay_operation(row) if row else None

    def heartbeat_relay_token_operation(
        self,
        operation_id: str,
        *,
        claim_owner: str,
        lease_seconds: int = 300,
    ) -> RelayTokenOperationRow | None:
        """Extend a live claim only when the owner still holds it."""
        with self._connect() as conn:
            row = conn.execute(
                f"""UPDATE platform_provider_relay_token_operation
                      SET lease_until=now() + (%s * interval '1 second'),updated_at=now()
                    WHERE operation_id=%s::uuid AND status='running' AND claim_owner=%s
                      AND lease_until IS NOT NULL AND lease_until > now()
                    RETURNING {self._operation_returning()}""",
                (lease_seconds, operation_id, claim_owner),
            ).fetchone()
        return self._relay_operation(row) if row else None
