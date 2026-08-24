"""Operator Provider/model/rate orchestration and tenant-scoped NewAPI access."""
from __future__ import annotations

import os
import secrets
from datetime import UTC, datetime, timedelta
from functools import lru_cache

from cryptography.fernet import Fernet

from shared.contracts.platform_provider import PlatformModel, PlatformModelRate, PlatformModelRef, PlatformProvider, TenantProviderAccess
from shared.config import load_settings
from shared.crypto import CryptoService
from shared.errors import Conflict, NotFound

from .newapi_client import NewApiAdminClient, NewApiError
from .platform_provider_repository import PlatformProviderRepository, ProviderRow, ModelRow, RateRow, AccessRow


class PlatformProviderService:
    def __init__(self, repo: PlatformProviderRepository, newapi: NewApiAdminClient, crypto: CryptoService, public_relay_url: str):
        self._repo = repo
        self._newapi = newapi
        self._crypto = crypto
        self._public_relay_url = public_relay_url.rstrip("/")

    def create_provider(self, *, provider_code: str, display_name: str, api_protocol: str, newapi_channel_id: int) -> PlatformProvider:
        try:
            row = self._repo.create_provider(
                provider_code=provider_code.strip(), display_name=display_name.strip(), relay_base_url=self._public_relay_url,
                api_protocol=api_protocol, newapi_channel_id=newapi_channel_id,
            )
        except Exception as exc:
            if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
                raise Conflict("platform provider code already exists") from exc
            raise
        return _provider(row)

    def list_providers(self, *, published_only: bool = False) -> list[PlatformProvider]:
        return [_provider(row) for row in self._repo.list_providers(published_only=published_only)]

    def publish_provider(self, provider_id: str) -> PlatformProvider:
        provider = self._require_provider(provider_id)
        models = self._repo.list_models(provider_id, published_only=True)
        if not models:
            raise Conflict("publish at least one priced model before publishing provider")
        if any((rate := self._repo.current_rate(provider_id, model.model_id)) is None or rate.pricing_status != "known" for model in models):
            raise Conflict("every published model requires a known active price")
        return _provider(self._repo.set_provider_status(provider.provider_id, "published"))

    def sync_models(self, provider_id: str) -> list[PlatformModel]:
        provider = self._require_provider(provider_id)
        if provider.newapi_channel_id is None:
            raise Conflict("provider has no internal NewAPI channel")
        try:
            model_ids = self._newapi.fetch_channel_models(provider.newapi_channel_id)
        except NewApiError as exc:
            raise Conflict(f"NewAPI model discovery failed: {exc}") from exc
        if not model_ids:
            raise Conflict("NewAPI discovered no models")
        return [_model(row) for row in self._repo.upsert_discovered_models(provider_id, model_ids)]

    def list_models(self, provider_id: str, *, published_only: bool = False) -> list[dict]:
        self._require_provider(provider_id)
        result = []
        for row in self._repo.list_models(provider_id, published_only=published_only):
            rate = self._repo.current_rate(provider_id, row.model_id)
            result.append({"model": _model(row), "rate": _rate(rate) if rate else None})
        return result

    def set_rate(self, provider_id: str, model_id: str, **values) -> PlatformModelRate:
        self._require_model(provider_id, model_id)
        effective = values.get("effective_from") or datetime.now(UTC)
        pricing_status = values.get("pricing_status", "known")
        if pricing_status == "known" and values.get("billing_mode", "token") == "token" and (
            values.get("input_usd_per_million") is None or values.get("output_usd_per_million") is None
        ):
            raise Conflict("known token pricing requires input and output rates")
        row = self._repo.create_rate(
            provider_id, model_id,
            pricing_status=pricing_status,
            billing_mode=values.get("billing_mode", "token"),
            input_usd_per_million=values.get("input_usd_per_million"),
            output_usd_per_million=values.get("output_usd_per_million"),
            cache_read_usd_per_million=values.get("cache_read_usd_per_million"),
            cache_write_usd_per_million=values.get("cache_write_usd_per_million"),
            request_usd=values.get("request_usd"),
            source=values.get("source", "manual"),
            source_version=values.get("source_version"),
            effective_from=effective,
            manually_overridden=values.get("source", "manual") == "manual",
        )
        return _rate(row)

    def publish_model(self, provider_id: str, model_id: str) -> PlatformModel:
        model = self._require_model(provider_id, model_id)
        rate = self._repo.current_rate(provider_id, model_id)
        if rate is None or rate.pricing_status != "known":
            raise Conflict("model requires a known active price before publishing")
        return _model(self._repo.set_model_status(provider_id, model.model_id, "published"))

    def validate_model_ref(self, ref: PlatformModelRef, *, require_published: bool = False) -> PlatformModelRef:
        provider = self._require_provider(ref.provider_id)
        model = self._require_model(ref.provider_id, ref.model_id)
        if provider.version != ref.provider_version or model.version != ref.model_version:
            raise Conflict("platform model reference version is stale")
        if require_published and (provider.status != "published" or model.status != "published"):
            raise Conflict("platform provider/model is not published")
        if require_published:
            rate = self._repo.current_rate(ref.provider_id, ref.model_id)
            if rate is None or rate.pricing_status != "known":
                raise Conflict("published platform model has no known active price")
        return ref

    def resolve_tenant_access(self, *, tenant_id: str, provider_id: str, model_ids: list[str]) -> dict:
        provider = self._require_provider(provider_id)
        if provider.status != "published":
            raise Conflict("platform provider is not published")
        allowed = sorted(set(model_ids))
        if not allowed:
            raise Conflict("at least one model is required")
        published = {model.model_id for model in self._repo.list_models(provider_id, published_only=True)}
        if not set(allowed) <= published:
            raise Conflict("tenant access may only include published platform models")
        existing = self._repo.get_access(tenant_id, provider_id)
        if existing:
            allowed = sorted(set(allowed) | set(existing.allowed_model_ids))
        if existing and existing.status == "active" and set(allowed) <= set(existing.allowed_model_ids):
            return self._runtime_access(provider, existing)
        if existing:
            management_token = self._crypto.decrypt(existing.encrypted_management_token)
            user_id = existing.newapi_user_id
            username = existing.newapi_username
        else:
            username = "at" + tenant_id.replace("-", "")[:10]
            if self._newapi.find_user(username):
                raise Conflict("NewAPI tenant user exists without an Operator access record")
            password = secrets.token_urlsafe(15)[:20]
            user_id = self._newapi.create_user(username=username, password=password, display_name=f"AI Team {tenant_id[:8]}")
            self._newapi.add_user_quota(user_id, 1_000_000_000)
            dashboard_token, login_user_id = self._newapi.login(username, password)
            if login_user_id != user_id:
                raise Conflict("NewAPI tenant identity mismatch")
            management_token = self._newapi.generate_management_token(dashboard_token, user_id)
        expires_at = datetime.now(UTC) + timedelta(days=90)
        token_name = f"aiteam-{tenant_id[:8]}-{provider.provider_code}-v{(existing.version + 1) if existing else 1}"[:30]
        token_id, relay_token = self._newapi.create_relay_token(
            dashboard_token=management_token, user_id=user_id, name=token_name, model_ids=allowed,
            remain_quota=100_000_000, expired_time=int(expires_at.timestamp()),
        )
        access = self._repo.upsert_access(
            tenant_id=tenant_id, provider_id=provider_id,
            encrypted_token=self._crypto.encrypt(relay_token), encrypted_management_token=self._crypto.encrypt(management_token),
            allowed_model_ids=allowed, newapi_username=username, newapi_user_id=user_id, newapi_token_id=token_id, expires_at=expires_at,
        )
        return self._runtime_access(provider, access)

    def access_metadata(self, tenant_id: str, provider_id: str) -> TenantProviderAccess:
        access = self._repo.get_access(tenant_id, provider_id)
        if not access:
            raise NotFound("tenant provider access not found")
        return _access(access)

    def _runtime_access(self, provider: ProviderRow, access: AccessRow) -> dict:
        return {
            "access": _access(access),
            "relay_base_url": provider.relay_base_url,
            "api_protocol": provider.api_protocol,
            "relay_token": self._crypto.decrypt(access.encrypted_token),
        }

    def _require_provider(self, provider_id: str) -> ProviderRow:
        row = self._repo.get_provider(provider_id)
        if not row:
            raise NotFound("platform provider not found")
        return row

    def _require_model(self, provider_id: str, model_id: str) -> ModelRow:
        row = self._repo.get_model(provider_id, model_id)
        if not row:
            raise NotFound("platform model not found")
        return row


def newapi_urls() -> tuple[str | None, str | None]:
    """Resolve the configurable NewAPI base URL and its OpenAI-compatible path."""
    base_url = (os.getenv("NEWAPI_URL") or "").rstrip("/") or None
    admin_url = (os.getenv("NEWAPI_ADMIN_BASE_URL") or base_url or "").rstrip("/") or None
    public_url = (os.getenv("NEWAPI_PUBLIC_BASE_URL") or (f"{base_url}/v1" if base_url else "")).rstrip("/") or None
    return admin_url, public_url


@lru_cache(maxsize=1)
def build_platform_provider_service() -> PlatformProviderService:
    settings = load_settings("operation")
    admin_url, public_url = newapi_urls()
    admin_token = os.getenv("NEWAPI_ADMIN_TOKEN")
    admin_user_id = os.getenv("NEWAPI_ADMIN_USER_ID")
    encryption_key = os.getenv("OPERATION_PROVIDER_CREDENTIAL_KEY")
    if not all((settings.admin_db_url, admin_url, public_url, admin_token, admin_user_id, encryption_key)):
        raise RuntimeError("Operator Provider/NewAPI settings are incomplete")
    return PlatformProviderService(
        PlatformProviderRepository(settings.admin_db_url),
        NewApiAdminClient(admin_url, admin_token, admin_user_id, timeout=settings.service_client_timeout_ms / 1000),
        CryptoService(Fernet(encryption_key.encode())),
        public_url,
    )


def _provider(row: ProviderRow) -> PlatformProvider:
    return PlatformProvider(**{key: getattr(row, key) for key in PlatformProvider.model_fields})


def _model(row: ModelRow) -> PlatformModel:
    return PlatformModel(**{key: getattr(row, key) for key in PlatformModel.model_fields})


def _rate(row: RateRow) -> PlatformModelRate:
    return PlatformModelRate(**{key: getattr(row, key) for key in PlatformModelRate.model_fields})


def _access(row: AccessRow) -> TenantProviderAccess:
    return TenantProviderAccess(**{key: getattr(row, key) for key in TenantProviderAccess.model_fields})
