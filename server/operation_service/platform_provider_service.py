"""Operator Provider/model/rate orchestration and tenant-scoped NewAPI access."""
from __future__ import annotations

import os
import secrets
import socket
from ipaddress import ip_address
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from urllib.parse import urlsplit, urlunsplit

from cryptography.fernet import Fernet

from shared.contracts.platform_provider import PlatformModel, PlatformModelRate, PlatformModelRef, PlatformProvider, TenantProviderAccess
from shared.config import load_settings
from shared.crypto import CryptoService
from shared.errors import Conflict, NotFound

from .newapi_client import NewApiAdminClient, NewApiError
from .platform_provider_repository import PlatformProviderRepository, ProviderRow, ModelRow, RateRow, AccessRow
from .public_pricing_client import ModelsDevPricingClient, PublicModelPrice, PublicPricingError


INTERNAL_PROVIDER_CODE = "newapi"
INTERNAL_PROVIDER_NAME = "LLM 网关"
INTERNAL_NEWAPI_CHANNEL_ID = 1


class PlatformProviderService:
    def __init__(
        self,
        repo: PlatformProviderRepository,
        newapi: NewApiAdminClient,
        crypto: CryptoService,
        public_relay_url: str,
        public_pricing: ModelsDevPricingClient | None = None,
        *,
        enterprise_repository=None,
    ):
        self._repo = repo
        self._newapi = newapi
        self._crypto = crypto
        self._enterprise = enterprise_repository
        self._public_relay_url = public_relay_url.rstrip("/")
        self._public_pricing = public_pricing or ModelsDevPricingClient(os.getenv("MODEL_PRICING_URL", "https://models.dev/api.json"))

    def ensure_internal_provider(self, *, sync_models: bool = True) -> PlatformProvider:
        row = self._repo.ensure_internal_provider(
            provider_code=INTERNAL_PROVIDER_CODE,
            display_name=INTERNAL_PROVIDER_NAME,
            relay_base_url=self._public_relay_url,
            api_protocol="openai-completions",
            newapi_channel_id=INTERNAL_NEWAPI_CHANNEL_ID,
        )
        if sync_models:
            self._auto_prepare_models(row, self._sync_models(row))
        return self._provider_output(row)

    def _auto_prepare_models(self, provider: ProviderRow, models: list[PlatformModel]) -> None:
        """Fill missing catalog metadata/prices and publish every priced model."""
        metadata_updater = getattr(self._repo, "update_model_metadata", None)
        if callable(metadata_updater) and any(
            not model.capabilities.get("thinking_levels")
            or "thinking_mode" not in model.capabilities
            for model in models
        ):
            self._sync_model_capabilities(provider.provider_id, models, metadata_updater)
        needs_public_prices = any(
            (rate := self._repo.current_rate(provider.provider_id, model.model_id)) is None
            or rate.pricing_status != "known"
            for model in models
        )
        if needs_public_prices:
            try:
                self.sync_public_prices(provider.provider_id)
            except Conflict:
                # A pricing-source outage must not hide an otherwise healthy gateway.
                pass
        self.publish_priced_models(provider.provider_id)

    def _sync_model_capabilities(self, provider_id: str, models: list[PlatformModel], updater) -> None:
        """Best-effort enrich discovered models from the same public catalog as prices."""
        try:
            prices = self._public_pricing.fetch()
        except PublicPricingError:
            return
        for model in models:
            price = prices.get(model.model_id.strip().lower())
            if price is None or not price.capabilities:
                continue
            updater(
                provider_id,
                model.model_id,
                display_name=model.display_name or price.display_name,
                capabilities=price.capabilities,
            )

    def list_providers(self, *, published_only: bool = False) -> list[PlatformProvider]:
        self.ensure_internal_provider()
        return [self._provider_output(row) for row in self._repo.list_providers(published_only=published_only)]

    def _sync_models(self, provider: ProviderRow) -> list[PlatformModel]:
        if provider.newapi_channel_id is None:
            raise Conflict("LLM 网关 channel is not configured")
        try:
            model_ids = self._newapi.get_channel_models(provider.newapi_channel_id)
        except NewApiError as exc:
            raise Conflict("LLM 网关 model discovery failed; check the gateway channel configuration") from exc
        if not model_ids:
            raise Conflict("LLM 网关 discovered no models")
        return [_model(row) for row in self._repo.upsert_discovered_models(provider.provider_id, model_ids)]

    def sync_models(self, provider_id: str) -> list[PlatformModel]:
        return self._sync_models(self._require_provider(provider_id))

    def list_models(self, provider_id: str, *, published_only: bool = False) -> list[dict]:
        self._require_provider(provider_id)
        result = []
        for row in self._repo.list_models(provider_id, published_only=published_only):
            rate = self._repo.current_rate(provider_id, row.model_id)
            result.append({"model": _model(row), "rate": _rate(rate) if rate else None})
        return result

    def list_platform_catalog(self, *, tenant_id: str | None = None) -> dict:
        """Return the published platform catalog, optionally tenant-filtered."""
        providers = self.list_providers(published_only=True)
        allowed = self._allowed_model_refs(tenant_id)
        models = [
            item
            for provider in providers
            for item in self.list_models(provider.provider_id, published_only=True)
            if allowed is None or _model_ref_allowed(item["model"], allowed)
        ]
        return {
            "providers": providers,
            "models": models,
            "model_access_configured": allowed is not None,
        }

    def _allowed_model_refs(self, tenant_id: str | None) -> list[dict] | None:
        if not tenant_id or self._enterprise is None:
            return None
        getter = getattr(self._enterprise, "get_by_tenant_id", None)
        if not callable(getter):
            return None
        try:
            account = getter(tenant_id)
        except NotFound:
            # A tenant-scoped service request must fail closed rather than
            # silently inheriting the unrestricted legacy view.
            return []
        refs = getattr(account, "allowed_model_refs", None)
        return refs if refs is None else [ref for ref in refs if isinstance(ref, dict)]

    def sync_public_prices(self, provider_id: str, *, force: bool = False) -> dict[str, int | str]:
        self._require_provider(provider_id)
        try:
            prices = self._public_pricing.fetch()
        except PublicPricingError as exc:
            raise Conflict(f"公开模型价格同步失败: {exc}") from exc
        updated = skipped_known = skipped_manual = unmatched = 0
        for model in self._repo.list_models(provider_id):
            price = prices.get(model.model_id.strip().lower())
            if price is None:
                unmatched += 1
                continue
            current = self._repo.current_rate(provider_id, model.model_id)
            if current and current.manually_overridden:
                skipped_manual += 1
                continue
            if current and current.pricing_status == "known":
                if not force or current.source != "public_reference" or _same_public_price(current, price):
                    skipped_known += 1
                    continue
            self.set_rate(
                provider_id,
                model.model_id,
                pricing_status="known",
                billing_mode="token",
                input_usd_per_million=price.input_usd_per_million,
                output_usd_per_million=price.output_usd_per_million,
                cache_read_usd_per_million=price.cache_read_usd_per_million,
                cache_write_usd_per_million=price.cache_write_usd_per_million,
                source="public_reference",
                source_version=price.source_version,
                effective_from=datetime.now(UTC),
            )
            updated += 1
        return {
            "source": "models.dev",
            "updated": updated,
            "skipped_known": skipped_known,
            "skipped_manual": skipped_manual,
            "unmatched": unmatched,
        }

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

    def publish_priced_models(self, provider_id: str) -> dict[str, int]:
        provider = self._require_provider(provider_id)
        if provider.status != "published":
            raise Conflict("publish the large-model service before publishing its models")
        published = self._repo.publish_priced_models(provider_id)
        return {"published": len(published)}

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

    def validate_model_thinking_level(
        self,
        ref: PlatformModelRef,
        thinking_level: str,
        *,
        require_published: bool = False,
    ) -> None:
        """Reject a template default that the pinned model cannot execute."""
        self.validate_model_ref(ref, require_published=require_published)
        model = self._require_model(ref.provider_id, ref.model_id)
        capabilities = model.capabilities or {}
        levels = capabilities.get("thinking_levels")
        if isinstance(levels, list) and levels:
            supported = {level for level in levels if isinstance(level, str)}
        else:
            mapping = capabilities.get("thinking_level_map")
            supported = {
                level for level, value in mapping.items()
                if isinstance(level, str) and value is not None
            } if isinstance(mapping, dict) else set()
        if supported and thinking_level not in supported:
            raise Conflict(
                f"thinking level {thinking_level!r} is not supported by platform model {ref.model_id!r}"
            )
        if capabilities.get("reasoning") is False and thinking_level != "off":
            raise Conflict(f"platform model {ref.model_id!r} does not support thinking")

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
        allowed_refs = self._allowed_model_refs(tenant_id)
        if allowed_refs is not None:
            if any(
                not _model_ref_allowed_by_id(provider_id, model_id, allowed_refs)
                for model_id in allowed
            ):
                # Hide enterprise policy details and make an unopened model
                # indistinguishable from a missing platform model.
                raise NotFound("platform model not found")
            # Keep relay token limits aligned with the current enterprise policy,
            # including removals made after an older token was issued.
            allowed = sorted({
                ref.get("model_id")
                for ref in allowed_refs
                if ref.get("provider_id") == provider_id
                and isinstance(ref.get("model_id"), str)
                and ref.get("model_id") in published
            })
        existing = self._repo.get_access(tenant_id, provider_id)
        if allowed_refs is None and existing:
            allowed = sorted(set(allowed) | set(existing.allowed_model_ids))
        if existing and existing.status == "active" and set(allowed) == set(existing.allowed_model_ids):
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
        try:
            token_id, relay_token = self._newapi.create_relay_token(
                dashboard_token=management_token, user_id=user_id, name=token_name, model_ids=allowed,
                remain_quota=100_000_000, expired_time=int(expires_at.timestamp()),
            )
        except NewApiError as exc:
            raise Conflict(f"NewAPI tenant relay token provisioning failed: {exc}") from exc
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
            "relay_base_url": self._public_relay_url,
            "api_protocol": provider.api_protocol,
            "relay_token": self._crypto.decrypt(access.encrypted_token),
        }

    def _provider_output(self, row: ProviderRow) -> PlatformProvider:
        return _provider(row).model_copy(update={"relay_base_url": self._public_relay_url})

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


def _validated_relay_url(value: str, *, name: str, https_only: bool = False, reject_local: bool = False) -> str:
    if not value or any(character.isspace() for character in value):
        raise ValueError(f"{name} must be an absolute HTTP(S) URL without credentials or query data")
    parsed = urlsplit(value)
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError(f"{name} has an invalid port") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(f"{name} must be an absolute HTTP(S) URL without credentials or query data")
    if name == "NEWAPI_PUBLIC_BASE_URL" and not parsed.path.rstrip("/").endswith("/v1"):
        raise ValueError(f"{name} must end with /v1")
    if https_only and parsed.scheme != "https":
        raise ValueError(f"{name} must use HTTPS")
    if reject_local:
        host = parsed.hostname.rstrip(".").lower()
        if "." not in host and ":" not in host:
            raise ValueError(f"{name} must use a qualified public hostname")
        if host == "localhost" or host.endswith(".localhost") or host.endswith(".local") or host.endswith(".localdomain") or host.endswith(".internal") or host.endswith(".intranet"):
            raise ValueError(f"{name} must not target a local destination")
        try:
            address = ip_address(parsed.hostname)
        except ValueError:
            address = None
        if address is not None and (address.is_loopback or address.is_private or address.is_link_local or address.is_unspecified or address.is_multicast):
            raise ValueError(f"{name} must not target a local destination")
        try:
            resolved = {
                ip_address(info[4][0])
                for info in socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
                if info[4] and info[4][0]
            }
        except (OSError, ValueError) as exc:
            raise ValueError(f"{name} DNS resolution failed") from exc
        if not resolved or any(not item.is_global for item in resolved):
            raise ValueError(f"{name} must resolve only to global destinations")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def newapi_urls(*, production: bool = False) -> tuple[str | None, str | None]:
    """Resolve separate NewAPI admin and externally reachable relay URLs.

    NEWAPI_URL is allowed to point at the private Operator→NewAPI network. It
    is never used as a fallback for the URL returned to Manager/Agent.
    """
    base_raw = os.getenv("NEWAPI_URL") or ""
    admin_raw = os.getenv("NEWAPI_ADMIN_BASE_URL") or base_raw
    public_raw = os.getenv("NEWAPI_PUBLIC_BASE_URL") or ""
    admin_url = _validated_relay_url(admin_raw, name="NEWAPI_ADMIN_BASE_URL") if admin_raw else None
    public_url = _validated_relay_url(public_raw, name="NEWAPI_PUBLIC_BASE_URL", https_only=production, reject_local=production) if public_raw else None
    return admin_url, public_url


@lru_cache(maxsize=1)
def build_platform_provider_service() -> PlatformProviderService:
    settings = load_settings("operation")
    admin_url, public_url = newapi_urls(production=settings.is_production)
    admin_token = os.getenv("NEWAPI_ADMIN_TOKEN")
    admin_user_id = os.getenv("NEWAPI_ADMIN_USER_ID")
    encryption_key = os.getenv("OPERATION_PROVIDER_CREDENTIAL_KEY")
    if not all((settings.db_url, admin_url, public_url, admin_token, admin_user_id, encryption_key)):
        raise RuntimeError("Operator LLM gateway settings are incomplete")
    from .repository import PgEnterpriseRepository

    return PlatformProviderService(
        PlatformProviderRepository(settings.db_url),
        NewApiAdminClient(admin_url, admin_token, admin_user_id, timeout=settings.service_client_timeout_ms / 1000),
        CryptoService(Fernet(encryption_key.encode())),
        public_url,
        ModelsDevPricingClient(os.getenv("MODEL_PRICING_URL", "https://models.dev/api.json"), timeout=settings.service_client_timeout_ms / 1000),
        enterprise_repository=PgEnterpriseRepository(settings.db_url),
    )


def _provider(row: ProviderRow) -> PlatformProvider:
    return PlatformProvider(**{key: getattr(row, key) for key in PlatformProvider.model_fields})


def _model(row: ModelRow) -> PlatformModel:
    return PlatformModel(**{key: getattr(row, key) for key in PlatformModel.model_fields})


def _rate(row: RateRow) -> PlatformModelRate:
    return PlatformModelRate(**{key: getattr(row, key) for key in PlatformModelRate.model_fields})


def _model_ref_allowed(model: PlatformModel, refs: list[dict]) -> bool:
    return _model_ref_allowed_by_id(model.provider_id, model.model_id, refs)


def _model_ref_allowed_by_id(provider_id: str, model_id: str, refs: list[dict]) -> bool:
    return any(
        ref.get("provider_id") == provider_id and ref.get("model_id") == model_id
        for ref in refs
    )


def _same_public_price(rate: RateRow, price: PublicModelPrice) -> bool:
    return (
        rate.input_usd_per_million == price.input_usd_per_million
        and rate.output_usd_per_million == price.output_usd_per_million
        and rate.cache_read_usd_per_million == price.cache_read_usd_per_million
        and rate.cache_write_usd_per_million == price.cache_write_usd_per_million
    )


def _access(row: AccessRow) -> TenantProviderAccess:
    return TenantProviderAccess(**{key: getattr(row, key) for key in TenantProviderAccess.model_fields})
