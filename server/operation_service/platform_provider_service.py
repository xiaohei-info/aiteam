"""Operator Provider/model/rate orchestration and tenant-scoped NewAPI access."""
from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import os
import re
import secrets
import socket
import threading
from datetime import UTC, datetime, timedelta
from contextlib import asynccontextmanager
from functools import lru_cache
from ipaddress import ip_address
from typing import Any, Callable
from urllib.parse import urlsplit, urlunsplit

from cryptography.fernet import Fernet

from shared.contracts.platform_provider import PlatformModel, PlatformModelRate, PlatformModelRef, PlatformProvider, TenantProviderAccess
from shared.config import load_settings
from shared.crypto import CryptoService
from shared.errors import Conflict, NotFound

from .newapi_client import NewApiAdminClient, NewApiError
from .platform_provider_repository import PlatformProviderRepository, ProviderRow, ModelRow, RateRow, AccessRow
from .public_pricing_client import ModelsDevPricingClient, PublicModelPrice, PublicPricingError


logger = logging.getLogger(__name__)


INTERNAL_PROVIDER_CODE = "newapi"
INTERNAL_PROVIDER_NAME = "LLM 网关"
INTERNAL_NEWAPI_CHANNEL_ID = 1

# Relay credentials are deliberately short-lived.  The renewal window is
# longer than a normal Manager pull so a near-expiry token is never handed to
# an Agent that may be offline immediately afterwards.
RELAY_TOKEN_LIFETIME = timedelta(days=90)
RELAY_TOKEN_RENEWAL_WINDOW = timedelta(hours=24)
RELAY_TOKEN_RETRY_BASE = timedelta(seconds=5)
RELAY_TOKEN_RETRY_MAX = timedelta(hours=1)
RELAY_TOKEN_HEARTBEAT_INTERVAL_SECONDS = 60
RELAY_TOKEN_RECOVERY_INTERVAL_SECONDS = 30
RELAY_TOKEN_RECOVERY_BATCH_LIMIT = 20
RELAY_TENANT_INITIAL_QUOTA = 1_000_000_000


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
        clock: Callable[[], datetime] | None = None,
        token_lifetime: timedelta = RELAY_TOKEN_LIFETIME,
        renewal_window: timedelta = RELAY_TOKEN_RENEWAL_WINDOW,
        heartbeat_interval: float = RELAY_TOKEN_HEARTBEAT_INTERVAL_SECONDS,
    ):
        if heartbeat_interval <= 0:
            raise ValueError("heartbeat interval must be positive")
        self._repo = repo
        self._newapi = newapi
        self._crypto = crypto
        self._enterprise = enterprise_repository
        self._public_relay_url = public_relay_url.rstrip("/")
        self._clock = clock or (lambda: datetime.now(UTC))
        self._token_lifetime = token_lifetime
        self._renewal_window = renewal_window
        self._heartbeat_interval = heartbeat_interval
        # Fallback only for lightweight in-memory test doubles.  Production
        # repositories expose the durable operation methods below; this map is
        # intentionally not used as a credential store.
        self._volatile_operations: dict[str, dict[str, Any]] = {}
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
        """Return the current effective platform catalog, optionally tenant-filtered.

        Provider/model release history is Operator-owned; consumers reference
        only stable provider/model identities.
        """
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
        updated = self._repo.set_model_status(provider_id, model.model_id, "published")
        if updated is None:
            raise NotFound("platform model not found")
        return _model(updated)

    def publish_priced_models(self, provider_id: str) -> dict[str, int]:
        provider = self._require_provider(provider_id)
        if provider.status != "published":
            raise Conflict("publish the large-model service before publishing its models")
        published = self._repo.publish_priced_models(provider_id)
        return {"published": len(published)}

    def validate_model_ref(self, ref: PlatformModelRef, *, require_published: bool = False) -> PlatformModelRef:
        """Validate stable Provider/model identity against the current catalog."""
        provider = self._require_provider(ref.provider_id)
        model = self._require_model(ref.provider_id, ref.model_id)
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
        """Resolve access under the shared policy and access fences."""
        access_lock = getattr(self._repo, "relay_access_lock", None)
        policy_lock = getattr(self._repo, "relay_policy_lock", None)

        def resolve_under_access_lock() -> dict:
            if callable(access_lock):
                with access_lock(tenant_id, provider_id):
                    return self._resolve_tenant_access(
                        tenant_id=tenant_id, provider_id=provider_id, model_ids=model_ids,
                    )
            return self._resolve_tenant_access(
                tenant_id=tenant_id, provider_id=provider_id, model_ids=model_ids,
            )

        # Always acquire the tenant-wide policy lock before the narrower
        # tenant/provider access lock. Policy writers acquire only the former,
        # which gives one order across providers without a reverse-lock cycle.
        if callable(policy_lock):
            with policy_lock(tenant_id):
                return resolve_under_access_lock()
        return resolve_under_access_lock()

    def _resolve_tenant_access(self, *, tenant_id: str, provider_id: str, model_ids: list[str]) -> dict:
        """Resolve a current tenant token, fencing stale grants first.

        A model-policy shrink is intentionally revoke-before-issue.  This can
        produce a short outage when NewAPI is unavailable, but it cannot leave
        a wider old token usable while a narrower replacement is being built.
        Renewal/expansion creates and durably records the replacement before
        attempting to retire the old token.
        """
        provider = self._require_provider(provider_id)
        if provider.status != "published":
            # A disabled provider must not leave a previously issued relay
            # token usable merely because the caller can no longer resolve a
            # new model.  Retire the local/upstream access before reporting the
            # catalog failure.
            existing = self._repo.get_access(tenant_id, provider_id)
            if existing:
                try:
                    self._revoke_existing_access(
                        existing,
                        tenant_id=tenant_id,
                        provider_id=provider_id,
                        desired_model_ids=[],
                        policy_revision=self._policy_revision(provider_id, []),
                    )
                except NewApiError as exc:
                    raise Conflict(f"NewAPI tenant relay token revocation failed: {_safe_lifecycle_error(exc)}") from exc
            raise Conflict("platform provider is not published")

        existing = self._repo.get_access(tenant_id, provider_id)
        requested = sorted({
            item.strip() for item in model_ids
            if isinstance(item, str) and item.strip()
        })
        allowed_refs = self._allowed_model_refs(tenant_id)
        published = {
            model.model_id
            for model in self._repo.list_models(provider_id, published_only=True)
        }
        if allowed_refs is not None:
            # Keep relay token limits aligned with the current enterprise
            # policy and the currently published model set.
            allowed = sorted({
                model_id
                for ref in allowed_refs
                for model_id in [ref.get("model_id")]
                if ref.get("provider_id") == provider_id
                and isinstance(model_id, str)
                and model_id in published
            })
        elif existing:
            # Without an explicit enterprise allow-list the tenant/provider
            # token is shared by multiple employees, but it must still lose
            # models that disappeared from the public catalog.
            allowed = sorted(
                (set(existing.allowed_model_ids) | set(requested)) & published
            )
        else:
            allowed = requested

        # Fence every removed model before validating the caller's requested
        # model list.  An invalid request must not become a way to skip a
        # policy shrink, and an add+remove policy change must retire the old
        # wider token before any replacement is issued.
        removed_fenced = False
        if (
            existing
            and existing.status == "active"
            and existing.newapi_token_id is not None
            and set(existing.allowed_model_ids) - set(allowed)
        ):
            try:
                self._revoke_existing_access(
                    existing,
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    desired_model_ids=allowed,
                    policy_revision=self._policy_revision(provider_id, allowed),
                )
            except NewApiError as exc:
                raise Conflict(f"NewAPI tenant relay token revocation failed: {_safe_lifecycle_error(exc)}") from exc
            existing = self._repo.get_access(tenant_id, provider_id) or existing
            removed_fenced = True

        if not requested:
            if not allowed:
                raise Conflict("tenant provider access has no allowed models")
            raise Conflict("at least one model is required")
        if not set(requested) <= published:
            raise Conflict("tenant access may only include published platform models")
        if allowed_refs is not None:
            if not allowed:
                raise Conflict("tenant provider access has no allowed models")
            if any(
                not _model_ref_allowed_by_id(provider_id, model_id, allowed_refs)
                for model_id in requested
            ):
                # Hide enterprise policy details and make an unopened model
                # indistinguishable from a missing platform model.
                raise NotFound("platform model not found")

        # Explicitly recover a failed/expired receipt before deciding whether a
        # current access row can be reused.  The recovery path is bounded and
        # uses the same stable operation keys as the inline path.
        self.recover_relay_token_operations(
            limit=20, force=False, tenant_id=tenant_id, provider_id=provider_id,
        )
        refreshed = self._repo.get_access(tenant_id, provider_id)
        if refreshed is not None:
            existing = refreshed
        if existing and existing.status == "active" and existing.newapi_token_id is None:
            # A legacy row without a proven upstream id cannot be safely
            # deleted or rotated by guessing its deterministic name.  Fence
            # the local projection and require explicit operator reconciliation.
            self._enqueue_unidentified_revoke_obligation(
                existing,
                tenant_id=tenant_id,
                provider_id=provider_id,
                policy_revision=self._policy_revision(provider_id, []),
            )
            raise Conflict("tenant relay access lifecycle identity is unavailable")

        # Final policy/publication CAS: the policy may have changed while the
        # resolver was waiting on recovery.  Never issue from the stale set.
        try:
            current_models = self._current_effective_models(tenant_id, provider_id)
        except NewApiError as exc:
            if existing and existing.status == "active" and existing.newapi_token_id is not None:
                try:
                    self._revoke_existing_access(
                        existing,
                        tenant_id=tenant_id,
                        provider_id=provider_id,
                        desired_model_ids=[],
                        policy_revision=self._policy_revision(provider_id, []),
                    )
                except NewApiError as revoke_exc:
                    raise Conflict(f"NewAPI tenant relay token revocation failed: {_safe_lifecycle_error(revoke_exc)}") from revoke_exc
            raise Conflict("platform provider policy is no longer available") from exc
        current_revision = self._policy_revision(provider_id, sorted(current_models))
        if (
            not set(allowed) <= current_models
            or (allowed_refs is not None and current_revision != self._policy_revision(provider_id, allowed))
        ):
            removed_now = set(existing.allowed_model_ids) - current_models if existing else set()
            if existing and existing.status == "active" and existing.newapi_token_id is not None and removed_now:
                try:
                    self._revoke_existing_access(
                        existing,
                        tenant_id=tenant_id,
                        provider_id=provider_id,
                        desired_model_ids=sorted(current_models),
                        policy_revision=self._policy_revision(provider_id, sorted(current_models)),
                    )
                except NewApiError as exc:
                    raise Conflict(f"NewAPI tenant relay token revocation failed: {_safe_lifecycle_error(exc)}") from exc
            raise Conflict("platform provider policy changed; retry access resolution")

        # A pre-validation fence leaves the current row revoked; do not repeat
        # the same upstream operation in the shrink branch below.
        policy_revision = self._policy_revision(provider_id, allowed)
        now = self._now()
        if (
            existing
            and existing.status == "active"
            and set(allowed) == set(existing.allowed_model_ids)
            and self._access_is_effective(existing, now)
            and not self._access_needs_renewal(existing, now)
        ):
            return self._runtime_access(provider, existing)

        if not allowed:
            if existing:
                try:
                    self._revoke_existing_access(
                        existing,
                        tenant_id=tenant_id,
                        provider_id=provider_id,
                        desired_model_ids=[],
                        policy_revision=policy_revision,
                    )
                except NewApiError as exc:
                    raise Conflict(f"NewAPI tenant relay token revocation failed: {_safe_lifecycle_error(exc)}") from exc
            raise Conflict("tenant provider access has no allowed models")

        # A strict shrink (including removal of a now-unpublished model) fences
        # the old token before any replacement is created.  Expansion and
        # renewal use the safer create-then-revoke sequence below.
        shrink = bool(
            existing
            and not removed_fenced
            and set(allowed) < set(existing.allowed_model_ids)
        )
        if existing and shrink:
            try:
                self._revoke_existing_access(
                    existing,
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    desired_model_ids=allowed,
                    policy_revision=policy_revision,
                )
            except NewApiError as exc:
                raise Conflict(f"NewAPI tenant relay token revocation failed: {_safe_lifecycle_error(exc)}") from exc
            existing = self._repo.get_access(tenant_id, provider_id) or existing

        # A failed safety revoke represents a known upstream object that may
        # still be enabled.  Do not create another generation while that
        # obligation is pending; otherwise repeated renewals could accumulate
        # unbounded live tokens during an outage.
        self._assert_relay_cleanup_clear(tenant_id, provider_id)

        try:
            access, old_access, old_revoke_operation = self._provision_relay_access(
                provider=provider,
                tenant_id=tenant_id,
                provider_id=provider_id,
                existing=existing,
                allowed_model_ids=allowed,
                policy_revision=policy_revision,
            )
        except NewApiError as exc:
            raise Conflict(f"NewAPI tenant relay token provisioning failed: {_safe_lifecycle_error(exc)}") from exc

        # A policy can change after the post-create check but before the local
        # transaction returns.  Recheck the revision and fence every token
        # involved in that attempt before exposing a possibly wider access.
        try:
            self._assert_policy_for_commit(
                tenant_id=tenant_id,
                provider_id=provider_id,
                allowed_model_ids=allowed,
                policy_revision=policy_revision,
            )
        except NewApiError as policy_exc:
            candidates = [access]
            if old_access and old_access.newapi_token_id != access.newapi_token_id:
                candidates.append(old_access)
            for candidate in candidates:
                try:
                    self._revoke_existing_access(
                        candidate,
                        tenant_id=tenant_id,
                        provider_id=provider_id,
                        desired_model_ids=[],
                        policy_revision=self._policy_revision(provider_id, []),
                    )
                except NewApiError:
                    # Each revoke has its own durable receipt; one outage must
                    # not allow this request to return a stale token.
                    pass
            raise Conflict("relay token policy changed before access commit") from policy_exc

        # The old token is already fenced for a shrink.  For renewal/expansion,
        # commit the replacement first and retain a durable revoke receipt if
        # retiring the old upstream object fails; the old scope was not wider
        # than the newly committed one in these branches.
        if (
            old_access
            and old_access.newapi_token_id is not None
            and old_access.newapi_token_id != access.newapi_token_id
            and not shrink
        ):
            try:
                if old_revoke_operation is not None and self._operation_status(old_revoke_operation) == "succeeded":
                    self._mark_lifecycle_revoked(tenant_id, provider_id, old_access.newapi_token_id)
                else:
                    # The replacement transaction already contains this
                    # receipt in production.  Re-enter the same stable path to
                    # claim/retry it; fallback fakes create it here.
                    self._revoke_existing_access(
                        old_access,
                        tenant_id=tenant_id,
                        provider_id=provider_id,
                        desired_model_ids=allowed,
                        policy_revision=policy_revision,
                    )
            except NewApiError:
                # The replacement remains usable, while the receipt makes the
                # old token cleanup retryable after an upstream outage.
                pass
        return self._runtime_access(provider, access)

    def _now(self) -> datetime:
        value = self._clock()
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)

    @staticmethod
    def _policy_revision(provider_id: str, model_ids: list[str]) -> str:
        canonical = json.dumps(
            {"provider_id": provider_id, "model_ids": sorted(set(model_ids))},
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return "sha256:" + hashlib.sha256(canonical).hexdigest()

    @staticmethod
    def _revoke_operation_key(
        tenant_id: str,
        provider_id: str,
        token_id: int,
        policy_revision: str,
    ) -> str:
        return f"relay:revoke:{tenant_id}:{provider_id}:{token_id}:{policy_revision}"

    def _assert_policy_for_commit(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        allowed_model_ids: list[str],
        policy_revision: str,
    ) -> None:
        current_models = self._current_effective_models(tenant_id, provider_id)
        if not set(allowed_model_ids) <= current_models:
            raise NewApiError("relay token policy changed before commit")
        refs = self._allowed_model_refs(tenant_id)
        if refs is not None and self._policy_revision(provider_id, sorted(current_models)) != policy_revision:
            raise NewApiError("relay token policy revision changed before commit")

    def _current_effective_models(self, tenant_id: str, provider_id: str) -> set[str]:
        provider = self._repo.get_provider(provider_id)
        if provider is None or provider.status != "published":
            raise NewApiError("relay lifecycle provider is no longer published")
        try:
            rows = self._repo.list_models(provider_id, published_only=True)
        except TypeError:
            rows = self._repo.list_models(provider_id)
        published = {
            model_id
            for row in rows
            for model_id, status in [(
                row.get("model_id"), row.get("status", "published")
            ) if isinstance(row, dict) else (
                getattr(row, "model_id", None), getattr(row, "status", "published")
            )]
            if isinstance(model_id, str) and status == "published"
        }
        refs = self._allowed_model_refs(tenant_id)
        if refs is None:
            return published
        return {
            model_id
            for ref in refs
            for model_id in [ref.get("model_id")]
            if ref.get("provider_id") == provider_id
            and isinstance(model_id, str)
            and model_id in published
        }

    def _access_is_effective(self, access: AccessRow, now: datetime | None = None) -> bool:
        if access.status != "active" or access.newapi_token_id is None or access.expires_at is None:
            return False
        expires_at = access.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)
        return expires_at.astimezone(UTC) > (now or self._now())

    def _access_needs_renewal(self, access: AccessRow, now: datetime | None = None) -> bool:
        if not self._access_is_effective(access, now):
            return True
        expires_at = access.expires_at
        assert expires_at is not None
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)
        return expires_at.astimezone(UTC) <= (now or self._now()) + self._renewal_window

    def _provision_relay_access(
        self,
        *,
        provider: ProviderRow,
        tenant_id: str,
        provider_id: str,
        existing: AccessRow | None,
        allowed_model_ids: list[str],
        policy_revision: str,
    ) -> tuple[AccessRow, AccessRow | None, Any | None]:
        expires_at = self._now() + self._token_lifetime
        bootstrap_operation = None
        if existing:
            management_token = self._decrypt_management_token(existing)
            user_id = existing.newapi_user_id
            username = existing.newapi_username
            if user_id is None:
                raise NewApiError("NewAPI tenant identity is unavailable")
        else:
            username = "at" + tenant_id.replace("-", "")[:10]
            if self._newapi.find_user(username):
                raise NewApiError("NewAPI tenant user exists without an Operator access record")
            password = secrets.token_urlsafe(15)[:20]
            bootstrap_operation = self._prepare_bootstrap(
                tenant_id=tenant_id,
                provider_id=provider_id,
                username=username,
                password=password,
                allowed_model_ids=allowed_model_ids,
                expires_at=expires_at,
                policy_revision=policy_revision,
            )
            try:
                user_id = self._ensure_bootstrap_user(
                    bootstrap_operation,
                    tenant_id=tenant_id,
                    username=username,
                    password=password,
                )
                self._set_bootstrap_identity(
                    tenant_id=tenant_id, provider_id=provider_id, user_id=user_id,
                )
                self._set_bootstrap_progress(bootstrap_operation, bootstrap_state="user_created")
                dashboard_token, login_user_id = self._call_upstream(
                    bootstrap_operation,
                    lambda: self._newapi.login(username, password),
                )
                if login_user_id != user_id:
                    raise NewApiError("NewAPI tenant identity mismatch")
                quota_before = self._call_upstream(
                    bootstrap_operation,
                    lambda: self._newapi.get_user_quota(
                        dashboard_token=dashboard_token, user_id=user_id,
                    ),
                )
                if quota_before < 0:
                    raise NewApiError("NewAPI tenant quota is invalid")
                self._set_bootstrap_progress(
                    bootstrap_operation,
                    bootstrap_state="quota_pending",
                    quota_before=quota_before,
                    quota_delta=RELAY_TENANT_INITIAL_QUOTA,
                )
                self._call_upstream(
                    bootstrap_operation,
                    lambda: self._newapi.add_user_quota(user_id, RELAY_TENANT_INITIAL_QUOTA),
                )
                self._set_bootstrap_progress(bootstrap_operation, bootstrap_state="quota_applied")
                management_token = self._call_upstream(
                    bootstrap_operation,
                    lambda: self._newapi.generate_management_token(dashboard_token, user_id),
                )
                self._complete_bootstrap(
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    user_id=user_id,
                    management_token=management_token,
                    allowed_model_ids=allowed_model_ids,
                    username=username,
                    policy_revision=policy_revision,
                )
                self._set_bootstrap_progress(bootstrap_operation, bootstrap_state="management_ready")
                self._set_bootstrap_progress(bootstrap_operation, bootstrap_state="completed")
                self._mark_operation_succeeded(bootstrap_operation)
                staged_access = self._repo.get_access(tenant_id, provider_id)
                if staged_access is not None:
                    existing = staged_access
            except NewApiError as exc:
                self._mark_operation_failed(bootstrap_operation, exc)
                raise
            except Exception as exc:
                safe = NewApiError("NewAPI tenant bootstrap outcome is unknown")
                self._mark_operation_failed(bootstrap_operation, safe)
                raise safe from exc

        next_version = (
            existing.version
            if existing and existing.status == "revoked" and existing.newapi_token_id is None
            else (existing.version + 1 if existing else 1)
        )
        token_name = _relay_token_name(tenant_id, provider.provider_code, next_version)
        issue_key = f"relay:issue:{tenant_id}:{provider_id}:{token_name}"
        issue = self._ensure_operation(
            tenant_id=tenant_id,
            provider_id=provider_id,
            newapi_user_id=user_id,
            newapi_token_id=None,
            token_name=token_name,
            operation_type="issue",
            operation_key=issue_key,
            desired_model_ids=allowed_model_ids,
            desired_expires_at=expires_at,
            policy_revision=policy_revision,
            expected_access_version=existing.version if existing else 0,
            expected_access_token_id=existing.newapi_token_id if existing else None,
        )
        claimed_issue = self._claim_operation(issue)
        if claimed_issue is None:
            latest = self._repo.get_access(tenant_id, provider_id)
            if (
                latest
                and set(latest.allowed_model_ids) == set(allowed_model_ids)
                and self._access_is_effective(latest)
                and not self._access_needs_renewal(latest)
            ):
                return latest, latest, None
            raise NewApiError("relay token issue operation is already in progress")
        issue = claimed_issue
        token_id: int | None = None
        try:
            # create_relay_token first lists the deterministic name, so retrying
            # after an unknown POST result reconciles instead of creating a copy.
            token_id, relay_token = self._issue_relay_token(
                issue,
                dashboard_token=management_token,
                user_id=user_id,
                name=token_name,
                model_ids=allowed_model_ids,
                expired_time=int(expires_at.timestamp()),
            )
            self._bind_operation(issue, token_id)
            try:
                self._assert_policy_for_commit(
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    allowed_model_ids=allowed_model_ids,
                    policy_revision=policy_revision,
                )
            except NewApiError as exc:
                raise NewApiError(str(exc), token_id=token_id) from exc
            access, old_operation = self._persist_access(
                tenant_id=tenant_id,
                provider_id=provider_id,
                relay_token=relay_token,
                management_token=management_token,
                allowed_model_ids=allowed_model_ids,
                username=username,
                user_id=user_id,
                token_id=token_id,
                expires_at=expires_at,
                policy_revision=policy_revision,
                token_name=token_name,
                old_access=existing,
                operation=issue,
            )
            self._mark_operation_succeeded(issue)
            return access, existing, old_operation
        except NewApiError as exc:
            self._reconcile_failed_issue(
                issue,
                tenant_id=tenant_id,
                provider_id=provider_id,
                management_token=management_token,
                user_id=user_id,
                token_name=token_name,
                username=username,
                allowed_model_ids=allowed_model_ids,
                expires_at=expires_at,
                policy_revision=policy_revision,
                error=exc,
            )
            self._mark_operation_failed(issue, exc)
            raise
        except Exception as exc:
            safe = NewApiError(
                "NewAPI relay token provisioning outcome is unknown",
                token_id=token_id,
            )
            self._reconcile_failed_issue(
                issue,
                tenant_id=tenant_id,
                provider_id=provider_id,
                management_token=management_token,
                user_id=user_id,
                token_name=token_name,
                username=username,
                allowed_model_ids=allowed_model_ids,
                expires_at=expires_at,
                policy_revision=policy_revision,
                error=safe,
            )
            self._mark_operation_failed(issue, safe)
            raise safe from exc

    def _issue_relay_token(
        self,
        operation: Any,
        *,
        dashboard_token: str,
        user_id: int,
        name: str,
        model_ids: list[str],
        expired_time: int,
    ) -> tuple[int, str]:
        """Issue once, or reconcile a prior create without another POST."""
        if expired_time != -1:
            try:
                requested_expiry = datetime.fromtimestamp(expired_time, tz=UTC)
            except (OverflowError, OSError, ValueError) as exc:
                raise NewApiError("relay token issue has invalid expiry") from exc
            if requested_expiry <= self._now():
                # Let the caller retain/reconcile any ID already observed on
                # the receipt; never create or publish an already-expired key.
                raise NewApiError(
                    "relay token issue expired before upstream work",
                    token_id=_operation_optional_int(operation, "newapi_token_id"),
                )
        state = _operation_text(operation, "create_attempt_state", "not_started")
        if state in {"in_flight", "unknown", "observed", "succeeded"}:
            reconcile = getattr(self._newapi, "reconcile_relay_token", None)
            if not callable(reconcile):
                raise NewApiError("relay token create attempt cannot be reconciled")
            result = reconcile(
                dashboard_token=dashboard_token,
                user_id=user_id,
                name=name,
                model_ids=model_ids,
                expired_time=expired_time,
            )
            if result is None:
                raise NewApiError("relay token create attempt was not reconciled; refusing another POST")
            token_id = result[0]
            try:
                self._set_create_attempt_state(operation, "observed")
            except NewApiError as exc:
                raise NewApiError(str(exc), token_id=token_id) from exc
            return result

        self._set_create_attempt_state(operation, "in_flight")
        try:
            result = self._call_upstream(
                operation,
                lambda: self._newapi.create_relay_token(
                    dashboard_token=dashboard_token,
                    user_id=user_id,
                    name=name,
                    model_ids=model_ids,
                    remain_quota=100_000_000,
                    expired_time=expired_time,
                ),
            )
        except Exception:
            try:
                self._set_create_attempt_state(operation, "unknown")
            except Exception:
                pass
            raise
        token_id = result[0] if isinstance(result, tuple) and result and isinstance(result[0], int) else None
        try:
            self._set_create_attempt_state(operation, "observed")
        except NewApiError as exc:
            raise NewApiError(str(exc), token_id=token_id) from exc
        return result

    def _reconcile_superseded_issue_token(
        self,
        issue: Any,
        access: AccessRow | None,
        *,
        tenant_id: str,
        provider_id: str,
        token_id: int,
        perform: bool = True,
    ) -> None:
        """Durably fence a bound token before retiring a stale issue receipt."""
        token_name = _operation_text(issue, "token_name")
        desired_model_ids = _operation_models(issue, "desired_model_ids")
        expires_at = _operation_datetime(issue, "desired_expires_at")
        policy_revision = _operation_text(issue, "policy_revision")
        user_id = _operation_optional_int(issue, "newapi_user_id")
        if user_id is None and access is not None:
            user_id = access.newapi_user_id
        if (
            access is not None
            and access.status == "active"
            and access.newapi_token_id == token_id
            and self._access_is_effective(access)
        ):
            try:
                self._cancel_adopted_revoke(
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    token_id=token_id,
                )
            except Exception as exc:
                raise NewApiError(
                    "relay token adoption cleanup is still live",
                    token_id=token_id,
                ) from exc
            return
        revoke_operation = self._ensure_operation(
            tenant_id=tenant_id,
            provider_id=provider_id,
            newapi_user_id=user_id,
            newapi_token_id=token_id,
            token_name=token_name,
            operation_type="revoke",
            operation_key=self._revoke_operation_key(tenant_id, provider_id, token_id, policy_revision),
            desired_model_ids=desired_model_ids,
            desired_expires_at=expires_at,
            policy_revision=policy_revision,
        )
        # The operation receipt is the durable tracking boundary even if the
        # access row or management credential is unavailable for this attempt.
        try:
            self._record_relay_token(
                tenant_id=tenant_id,
                provider_id=provider_id,
                newapi_user_id=user_id,
                newapi_token_id=token_id,
                token_name=token_name,
                allowed_model_ids=desired_model_ids,
                expires_at=expires_at,
                policy_revision=policy_revision,
                status="unknown",
            )
        except Exception:
            pass
        if not perform or access is None or self._operation_status(revoke_operation) == "succeeded":
            return
        claimed = self._claim_operation(revoke_operation, force=True)
        if claimed is None:
            return
        try:
            observed = self._revoke_upstream(access, token_id, operation=claimed)
        except Exception as exc:
            safe = exc if isinstance(exc, NewApiError) else NewApiError(
                "NewAPI relay token safety revoke outcome is unknown",
            )
            self._mark_operation_failed(claimed, safe)
            return
        self._mark_operation_succeeded(claimed)
        self._mark_lifecycle_revoked(tenant_id, provider_id, token_id, observed=observed)

    def _reconcile_failed_issue(
        self,
        issue: Any,
        *,
        tenant_id: str,
        provider_id: str,
        management_token: str,
        user_id: int,
        token_name: str,
        username: str | None = None,
        allowed_model_ids: list[str],
        expires_at: datetime,
        policy_revision: str,
        error: NewApiError,
    ) -> None:
        """Fence a token observed after a create/key read became uncertain."""
        token_id = getattr(error, "token_id", None)
        try:
            token_id = int(token_id) if token_id is not None else None
        except (TypeError, ValueError):
            token_id = None
        # A token ID carried by NewApiError came from a verified upstream
        # object.  Keep it directly for safety revoke; requiring another list
        # request here would turn a transient reconciliation failure into an
        # untracked orphan.  Only an unknown ID requires name reconciliation.
        if token_id is None:
            finder = getattr(self._newapi, "find_relay_token_by_name", None)
            if callable(finder):
                try:
                    remote = self._call_upstream(
                        issue,
                        lambda: finder(
                            dashboard_token=management_token, user_id=user_id, name=token_name,
                        ),
                    )
                    token_id = _remote_token_id(remote)
                except Exception:
                    # Name reconciliation is only accepted after the client's
                    # complete, ambiguity-checked pagination; no guessed ID.
                    token_id = None
        if token_id is None:
            return
        # If the replacement transaction already committed this exact token,
        # it is the current active credential—not an orphan to revoke.  This
        # check protects against post-commit receipt/read failures.
        try:
            current = self._repo.get_access(tenant_id, provider_id)
        except Exception:
            # A failed local read cannot prove that the observed token is an
            # orphan.  Persist the exact-ID obligation, but defer the upstream
            # call until recovery can re-check the current access row.
            try:
                self._reconcile_superseded_issue_token(
                    issue,
                    None,
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    token_id=token_id,
                    perform=False,
                )
            except Exception as exc:
                raise NewApiError(
                    "relay token safety revoke obligation is unavailable",
                    token_id=token_id,
                ) from exc
            return
        safety_access = current
        if current is None:
            try:
                safety_access = AccessRow(
                    "", tenant_id, provider_id, b"",
                    self._crypto.encrypt(management_token), [],
                    username or token_name, user_id, token_id, "revoked", 1, expires_at,
                )
            except Exception:
                safety_access = None
        # Establish the exact-ID safety receipt before any local staging,
        # binding, or lifecycle-record write that may fail after creation.
        try:
            self._reconcile_superseded_issue_token(
                issue,
                safety_access,
                tenant_id=tenant_id,
                provider_id=provider_id,
                token_id=token_id,
                perform=False,
            )
        except Exception as exc:
            raise NewApiError(
                "relay token safety revoke obligation is unavailable",
                token_id=token_id,
            ) from exc
        if (
            current
            and current.status == "active"
            and current.newapi_token_id == token_id
        ):
            # This is an adoption, not an orphan.  Clear any stale safety
            # receipt before a recovery worker can revoke the current token.
            try:
                self._cancel_adopted_revoke(
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    token_id=token_id,
                )
            except Exception:
                # A live receipt is deliberately not force-cancelled; the
                # atomic adoption path prevents new instances of this race.
                pass
            return
        if current and current.status == "active" and current.newapi_token_id != token_id:
            try:
                current_allowed = self._current_effective_models(tenant_id, provider_id)
                current_stale = not set(current.allowed_model_ids) <= current_allowed
            except Exception:
                # A catalog/policy read failure is not evidence that the
                # already-current token is stale; protect it from an
                # opportunistic safety revoke and let the normal resolver
                # retry the policy fence.
                current_stale = False
            if current_stale:
                try:
                    self._revoke_existing_access(
                        current,
                        tenant_id=tenant_id,
                        provider_id=provider_id,
                        desired_model_ids=[],
                        policy_revision=self._policy_revision(provider_id, []),
                    )
                except Exception:
                    # The local revoke and durable receipt are attempted inside
                    # the helper; an upstream outage leaves the token fenced.
                    pass
        if current is None:
            # Preserve a durable generation even when the failed issue had no
            # prior local access row (for example a legacy deployment).  This
            # row is revoked and carries only the encrypted management token;
            # it is never exposed as runtime access.
            try:
                self._stage_access_for_recovery(
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    management_token=management_token,
                    allowed_model_ids=allowed_model_ids,
                    username=username or token_name,
                    user_id=user_id,
                    policy_revision=policy_revision,
                    encrypted_bootstrap_password=None,
                )
            except Exception:
                return
        bump = getattr(self._repo, "bump_relay_access_generation", None)
        if callable(bump):
            try:
                bump(tenant_id, provider_id, expected_token_id=token_id)
            except Exception:
                # Revoke receipt persistence below remains the source of truth;
                # generation can be repaired by the next explicit resolution.
                pass
        try:
            self._bind_operation(issue, token_id)
        except Exception:
            return
        try:
            self._record_relay_token(
                tenant_id=tenant_id,
                provider_id=provider_id,
                newapi_user_id=user_id,
                newapi_token_id=token_id,
                token_name=token_name,
                allowed_model_ids=allowed_model_ids,
                expires_at=expires_at,
                policy_revision=policy_revision,
                status="unknown",
            )
            revoke_operation = self._ensure_operation(
                tenant_id=tenant_id,
                provider_id=provider_id,
                newapi_user_id=user_id,
                newapi_token_id=token_id,
                token_name=token_name,
                operation_type="revoke",
                operation_key=self._revoke_operation_key(tenant_id, provider_id, token_id, policy_revision),
                desired_model_ids=allowed_model_ids,
                desired_expires_at=expires_at,
                policy_revision=policy_revision,
            )
            if self._operation_status(revoke_operation) == "succeeded":
                self._mark_lifecycle_revoked(tenant_id, provider_id, token_id, observed=False)
                return
            claimed = self._claim_operation(revoke_operation, force=True)
            if claimed is None:
                return
            try:
                observed = self._revoke_upstream(
                    AccessRow(
                        "", tenant_id, provider_id, b"",
                        self._crypto.encrypt(management_token), [], token_name,
                        user_id, token_id, "revoked", 1, expires_at,
                    ),
                    token_id,
                    operation=claimed,
                )
            except Exception as exc:
                safe = exc if isinstance(exc, NewApiError) else NewApiError("NewAPI relay token safety revoke outcome is unknown")
                self._mark_operation_failed(claimed, safe)
                return
            self._mark_operation_succeeded(claimed)
            self._mark_lifecycle_revoked(tenant_id, provider_id, token_id, observed=observed)
        except Exception:
            # The original issue receipt remains failed and retryable.  Never
            # turn a persistence failure into a claim that the token is gone.
            return

    def _prepare_bootstrap(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        username: str,
        password: str,
        allowed_model_ids: list[str],
        expires_at: datetime,
        policy_revision: str,
    ) -> Any:
        """Write a bootstrap receipt before the first NewAPI write."""
        operation_key = f"relay:bootstrap:{tenant_id}:{provider_id}:{username}"
        stage = getattr(self._repo, "stage_relay_access_with_operation", None)
        try:
            if callable(stage):
                kwargs = {
                    "tenant_id": tenant_id,
                    "provider_id": provider_id,
                    "encrypted_management_token": self._crypto.encrypt(""),
                    "encrypted_bootstrap_password": self._crypto.encrypt(password),
                    "allowed_model_ids": allowed_model_ids,
                    "newapi_username": username,
                    "policy_revision": policy_revision,
                    "operation_key": operation_key,
                    "expires_at": expires_at,
                    "encrypted_token": self._crypto.encrypt(""),
                }
                filtered = {
                    key: value for key, value in kwargs.items()
                    if _accepts_keyword(stage, key)
                }
                _access, operation = stage(**filtered)
            else:
                stage = getattr(self._repo, "stage_relay_access", None)
                if callable(stage):
                    kwargs = {
                        "tenant_id": tenant_id,
                        "provider_id": provider_id,
                        "encrypted_management_token": self._crypto.encrypt(""),
                        "encrypted_bootstrap_password": self._crypto.encrypt(password),
                        "allowed_model_ids": allowed_model_ids,
                        "newapi_username": username,
                        "newapi_user_id": None,
                        "policy_revision": policy_revision,
                        "encrypted_token": self._crypto.encrypt(""),
                    }
                    filtered = {
                        key: value for key, value in kwargs.items()
                        if _accepts_keyword(stage, key)
                    }
                    stage(**filtered)
                operation = self._ensure_operation(
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    newapi_user_id=None,
                    newapi_token_id=None,
                    token_name=username,
                    operation_type="bootstrap",
                    operation_key=operation_key,
                    desired_model_ids=allowed_model_ids,
                    desired_expires_at=expires_at,
                    policy_revision=policy_revision,
                )
            claimed = self._claim_operation(operation)
        except NewApiError:
            raise
        except Exception as exc:
            raise NewApiError("relay tenant bootstrap receipt is unavailable") from exc
        if claimed is None:
            raise NewApiError("relay tenant bootstrap operation is already in progress")
        return claimed

    @staticmethod
    def _new_claim_owner() -> str:
        """Create an owner nonce for one durable operation claim."""
        return "operation-" + secrets.token_urlsafe(18)

    @staticmethod
    def _operation_claim_owner(operation: Any) -> str | None:
        value = _operation_value(operation, "claim_owner")
        return value if isinstance(value, str) and value else None

    @classmethod
    def _owner_kwargs(cls, operation: Any, method) -> dict[str, str]:
        if not _accepts_keyword(method, "claim_owner"):
            return {}
        owner = cls._operation_claim_owner(operation)
        if owner is None:
            raise NewApiError("relay lifecycle receipt has no claim owner")
        return {"claim_owner": owner}

    @staticmethod
    def _set_dict_claim_owner(operation: Any, owner: str) -> None:
        if isinstance(operation, dict):
            operation["claim_owner"] = owner

    def _ensure_claim_owner(self, operation: Any) -> Any:
        if self._operation_claim_owner(operation) is not None:
            return operation
        if isinstance(operation, dict):
            self._set_dict_claim_owner(operation, self._new_claim_owner())
            if operation.get("status") not in {"running", "succeeded"}:
                operation["status"] = "running"
            return operation
        raise NewApiError("relay lifecycle claim owner is unavailable")

    def _set_bootstrap_progress(
        self,
        operation: Any,
        *,
        bootstrap_state: str,
        quota_before: int | None = None,
        quota_delta: int | None = None,
    ) -> None:
        method = getattr(self._repo, "update_relay_bootstrap_progress", None)
        if callable(method):
            kwargs: dict[str, Any] = {
                "bootstrap_state": bootstrap_state,
                "quota_before": quota_before,
                "quota_delta": quota_delta,
            }
            kwargs.update(self._owner_kwargs(operation, method))
            result = method(self._operation_id(operation), **kwargs)
            if result is None:
                raise NewApiError("relay tenant bootstrap progress is stale")
            return
        if isinstance(operation, dict):
            operation["bootstrap_state"] = bootstrap_state
            if quota_before is not None:
                operation["quota_before"] = quota_before
            if quota_delta is not None:
                operation["quota_delta"] = quota_delta

    def _ensure_bootstrap_user(
        self,
        operation: Any,
        *,
        tenant_id: str,
        username: str,
        password: str,
    ) -> int:
        """Resolve an exact username before permitting a second user POST."""
        state = _operation_text(operation, "user_create_state", "not_started")
        existing = self._call_upstream(
            operation,
            lambda: self._newapi.find_user(username),
        )
        user_id = _remote_token_id(existing)
        if user_id is not None:
            try:
                self._set_user_create_state(operation, "observed", user_id=user_id)
            except NewApiError as exc:
                raise NewApiError(str(exc)) from exc
            return user_id
        if state != "not_started":
            raise NewApiError(
                "NewAPI tenant user create attempt was not reconciled; refusing another POST",
            )
        self._set_user_create_state(operation, "in_flight")
        try:
            user_id = self._call_upstream(
                operation,
                lambda: self._newapi.create_user(
                    username=username,
                    password=password,
                    display_name=f"AI Team {tenant_id[:8]}",
                ),
            )
        except Exception:
            try:
                self._set_user_create_state(operation, "unknown")
            except Exception:
                pass
            raise
        try:
            self._set_user_create_state(operation, "observed", user_id=user_id)
        except NewApiError as exc:
            raise NewApiError(str(exc)) from exc
        return user_id

    def _set_create_attempt_state(self, operation: Any, state: str) -> None:
        method = getattr(self._repo, "update_relay_token_create_state", None)
        if callable(method):
            kwargs: dict[str, Any] = {"create_attempt_state": state}
            kwargs.update(self._owner_kwargs(operation, method))
            result = method(self._operation_id(operation), **kwargs)
            if result is None:
                raise NewApiError("relay token create receipt is stale")
        elif isinstance(operation, dict):
            operation["create_attempt_state"] = state

    def _set_user_create_state(
        self,
        operation: Any,
        state: str,
        *,
        user_id: int | None = None,
    ) -> None:
        method = getattr(self._repo, "update_relay_user_create_state", None)
        if callable(method):
            kwargs: dict[str, Any] = {"user_create_state": state, "newapi_user_id": user_id}
            kwargs.update(self._owner_kwargs(operation, method))
            result = method(self._operation_id(operation), **kwargs)
            if result is None:
                raise NewApiError("relay tenant bootstrap receipt is stale")
        elif isinstance(operation, dict):
            operation["user_create_state"] = state
            if user_id is not None:
                operation["newapi_user_id"] = user_id

    def _set_bootstrap_identity(self, *, tenant_id: str, provider_id: str, user_id: int) -> None:
        method = getattr(self._repo, "set_relay_bootstrap_identity", None)
        if callable(method):
            result = method(
                tenant_id=tenant_id, provider_id=provider_id, newapi_user_id=user_id,
            )
            if result is None:
                raise NewApiError("relay tenant bootstrap identity is unavailable")

    def _complete_bootstrap(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        user_id: int,
        management_token: str,
        allowed_model_ids: list[str],
        username: str,
        policy_revision: str,
    ) -> None:
        method = getattr(self._repo, "complete_relay_bootstrap", None)
        if callable(method):
            result = method(
                tenant_id=tenant_id,
                provider_id=provider_id,
                newapi_user_id=user_id,
                encrypted_management_token=self._crypto.encrypt(management_token),
            )
            if result is None:
                raise NewApiError("relay tenant bootstrap completion is unavailable")
            return
        # Lightweight repository fakes may only expose stage; keep the row
        # revoked while replacing the encrypted management credential.
        self._stage_access_for_recovery(
            tenant_id=tenant_id,
            provider_id=provider_id,
            management_token=management_token,
            allowed_model_ids=allowed_model_ids,
            username=username,
            user_id=user_id,
            policy_revision=policy_revision,
            encrypted_bootstrap_password=None,
        )

    def _decrypt_bootstrap_password(self, access: AccessRow) -> str:
        value = access.encrypted_bootstrap_password
        if value is None:
            raise NewApiError("relay tenant bootstrap password is unavailable")
        try:
            password = self._crypto.decrypt(value)
        except Exception as exc:
            raise NewApiError("relay tenant bootstrap password is unavailable") from exc
        if not isinstance(password, str) or not password:
            raise NewApiError("relay tenant bootstrap password is unavailable")
        return password

    def _decrypt_management_token(self, access: AccessRow) -> str:
        try:
            value = self._crypto.decrypt(access.encrypted_management_token)
        except Exception as exc:
            raise NewApiError("NewAPI tenant management credential is unavailable") from exc
        if not isinstance(value, str) or not value:
            raise NewApiError("NewAPI tenant management credential is unavailable")
        return value

    def _stage_access_for_recovery(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        management_token: str,
        allowed_model_ids: list[str],
        username: str,
        user_id: int | None,
        policy_revision: str,
        encrypted_bootstrap_password: bytes | None = None,
    ) -> None:
        stage = getattr(self._repo, "stage_relay_access", None)
        if not callable(stage):
            return
        try:
            kwargs = {
                "tenant_id": tenant_id,
                "provider_id": provider_id,
                "encrypted_management_token": self._crypto.encrypt(management_token),
                "allowed_model_ids": allowed_model_ids,
                "newapi_username": username,
                "newapi_user_id": user_id,
                "encrypted_bootstrap_password": encrypted_bootstrap_password,
                "policy_revision": policy_revision,
            }
            if _accepts_keyword(stage, "encrypted_token"):
                kwargs["encrypted_token"] = self._crypto.encrypt("")
            filtered = {
                key: value for key, value in kwargs.items()
                if _accepts_keyword(stage, key)
            }
            stage(**filtered)
        except Exception as exc:
            raise NewApiError("relay lifecycle state is unavailable") from exc

    def _persist_access(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        relay_token: str,
        management_token: str,
        allowed_model_ids: list[str],
        username: str,
        user_id: int,
        token_id: int,
        expires_at: datetime,
        policy_revision: str,
        token_name: str,
        old_access: AccessRow | None = None,
        operation: Any | None = None,
    ) -> tuple[AccessRow, Any | None]:
        operation_id = self._operation_id(operation) if operation is not None else ""
        claim_owner = self._operation_claim_owner(operation) if operation is not None else None
        if operation_id and claim_owner:
            # Refresh once immediately before the repository CAS.  The
            # repository repeats the owner+lease check in its transaction so a
            # takeover after this precheck still cannot publish stale access.
            if self.heartbeat_relay_token_operation(operation) is None:
                raise NewApiError("relay lifecycle access commit claim is stale")
        encrypted_token = self._crypto.encrypt(relay_token)
        old_token_id = (
            old_access.newapi_token_id
            if old_access and old_access.newapi_token_id is not None and old_access.newapi_token_id != token_id
            else None
        )
        old_operation_key = (
            self._revoke_operation_key(tenant_id, provider_id, old_token_id, policy_revision)
            if old_token_id is not None else None
        )
        old_operation_values = {
            "old_token_id": old_token_id,
            "old_token_user_id": old_access.newapi_user_id if old_access else None,
            "old_operation_key": old_operation_key,
            "old_token_name": "",
            "old_desired_model_ids": allowed_model_ids,
            "old_desired_expires_at": expires_at,
            "old_policy_revision": policy_revision,
            "expected_version": old_access.version if old_access else 0,
            "expected_token_id": old_access.newapi_token_id if old_access else None,
            "expected_policy_revision": old_access.policy_revision if old_access else None,
        }
        encrypted_management_token = self._crypto.encrypt(management_token)
        atomic = getattr(self._repo, "upsert_access_with_relay_token", None)
        if callable(atomic):
            atomic_kwargs = {
                "tenant_id": tenant_id,
                "provider_id": provider_id,
                "encrypted_token": encrypted_token,
                "encrypted_management_token": encrypted_management_token,
                "allowed_model_ids": allowed_model_ids,
                "newapi_username": username,
                "newapi_user_id": user_id,
                "newapi_token_id": token_id,
                "expires_at": expires_at,
                "policy_revision": policy_revision,
                "token_name": token_name,
            }
            atomic_kwargs.update({
                key: value for key, value in old_operation_values.items()
                if _accepts_keyword(atomic, key)
            })
            if operation_id and claim_owner:
                atomic_kwargs.update({
                    key: value for key, value in {
                        "operation_id": operation_id,
                        "claim_owner": claim_owner,
                    }.items()
                    if _accepts_keyword(atomic, key)
                })
            access = atomic(**atomic_kwargs)
            old_operation = None
            if old_operation_key:
                getter = getattr(self._repo, "get_relay_token_operation", None)
                if callable(getter):
                    # The atomic transaction has already committed.  A
                    # follow-up receipt read failing must not be treated as a
                    # failed replacement and trigger a revoke of the current
                    # active token.
                    try:
                        old_operation = getter(old_operation_key)
                    except Exception:
                        old_operation = None
            return access, old_operation
        if operation_id and claim_owner:
            raise NewApiError("relay lifecycle access commit fence is unavailable")
        self._cancel_adopted_revoke(
            tenant_id=tenant_id,
            provider_id=provider_id,
            token_id=token_id,
        )
        upsert = getattr(self._repo, "upsert_access")
        kwargs = {
            "tenant_id": tenant_id,
            "provider_id": provider_id,
            "encrypted_token": encrypted_token,
            "encrypted_management_token": encrypted_management_token,
            "allowed_model_ids": allowed_model_ids,
            "newapi_username": username,
            "newapi_user_id": user_id,
            "newapi_token_id": token_id,
            "expires_at": expires_at,
        }
        if _accepts_keyword(upsert, "policy_revision"):
            kwargs["policy_revision"] = policy_revision
        if _accepts_keyword(upsert, "expected_version"):
            kwargs["expected_version"] = old_access.version if old_access else 0
        if _accepts_keyword(upsert, "expected_token_id"):
            kwargs["expected_token_id"] = old_access.newapi_token_id if old_access else None
        if _accepts_keyword(upsert, "expected_policy_revision"):
            kwargs["expected_policy_revision"] = old_access.policy_revision if old_access else None
        access = upsert(**kwargs)
        self._record_relay_token(
            tenant_id=tenant_id,
            provider_id=provider_id,
            newapi_user_id=user_id,
            newapi_token_id=token_id,
            token_name=token_name,
            allowed_model_ids=allowed_model_ids,
            expires_at=expires_at,
            policy_revision=policy_revision,
        )
        old_operation = None
        if old_operation_key:
            old_operation = self._ensure_operation(
                tenant_id=tenant_id,
                provider_id=provider_id,
                newapi_user_id=old_access.newapi_user_id if old_access else None,
                newapi_token_id=old_token_id,
                token_name="",
                operation_type="revoke",
                operation_key=old_operation_key,
                desired_model_ids=allowed_model_ids,
                desired_expires_at=expires_at,
                policy_revision=policy_revision,
            )
        return access, old_operation

    def _cancel_adopted_revoke(
        self,
        *,
        tenant_id: str,
        provider_id: str,
        token_id: int,
        exclude_operation_id: str | None = None,
    ) -> None:
        method = getattr(self._repo, "cancel_relay_token_revoke_on_adoption", None)
        if not callable(method):
            return
        kwargs = {
            "tenant_id": tenant_id,
            "provider_id": provider_id,
            "newapi_token_id": token_id,
            "exclude_operation_id": exclude_operation_id,
        }
        result = method(**{
            key: value for key, value in kwargs.items()
            if _accepts_keyword(method, key)
        })
        if result is False:
            raise NewApiError("relay token adoption is blocked by a live safety revoke")

    def _record_relay_token(self, **values) -> Any:
        method = getattr(self._repo, "record_relay_token", None)
        if method is None:
            method = getattr(self._repo, "record_relay_token_lifecycle", None)
        if callable(method):
            filtered = {
                name: value for name, value in values.items()
                if _accepts_keyword(method, name)
            }
            return method(**filtered)
        return None

    def _revoke_existing_access(
        self,
        existing: AccessRow,
        *,
        tenant_id: str,
        provider_id: str,
        desired_model_ids: list[str],
        policy_revision: str,
    ) -> None:
        token_id = existing.newapi_token_id
        if token_id is None:
            self._enqueue_unidentified_revoke_obligation(
                existing,
                tenant_id=tenant_id,
                provider_id=provider_id,
                desired_model_ids=desired_model_ids,
                policy_revision=policy_revision,
            )
            return
        operation_key = self._revoke_operation_key(tenant_id, provider_id, token_id, policy_revision)
        operation = self._prepare_revocation(
            existing,
            tenant_id=tenant_id,
            provider_id=provider_id,
            token_id=token_id,
            operation_key=operation_key,
            desired_model_ids=desired_model_ids,
            policy_revision=policy_revision,
        )
        if self._operation_status(operation) == "succeeded":
            # This receipt predates the current call; do not fabricate a
            # historical revoke timestamp.
            self._mark_lifecycle_revoked(tenant_id, provider_id, token_id, observed=False)
            return
        claimed = self._claim_operation(operation)
        if claimed is None:
            raise NewApiError("relay token revoke operation is already in progress")
        operation = claimed
        try:
            observed = self._revoke_upstream(existing, token_id, operation=operation)
        except Exception as exc:
            safe = exc if isinstance(exc, NewApiError) else NewApiError("NewAPI relay token revocation outcome is unknown")
            self._mark_operation_failed(operation, safe)
            raise safe from exc
        self._mark_operation_succeeded(operation)
        self._mark_lifecycle_revoked(tenant_id, provider_id, token_id, observed=observed)

    def _prepare_revocation(
        self,
        existing: AccessRow,
        *,
        tenant_id: str,
        provider_id: str,
        token_id: int,
        operation_key: str,
        desired_model_ids: list[str],
        policy_revision: str,
    ) -> Any:
        atomic = getattr(self._repo, "prepare_relay_token_revocation", None)
        if callable(atomic):
            _access, operation = atomic(
                tenant_id=tenant_id,
                provider_id=provider_id,
                expected_token_id=token_id,
                newapi_user_id=existing.newapi_user_id,
                token_name="",
                operation_key=operation_key,
                desired_model_ids=desired_model_ids,
                desired_expires_at=existing.expires_at,
                policy_revision=policy_revision,
            )
            return operation
        self._mark_local_revoked(tenant_id, provider_id, expected_token_id=token_id)
        return self._ensure_operation(
            tenant_id=tenant_id,
            provider_id=provider_id,
            newapi_user_id=existing.newapi_user_id,
            newapi_token_id=token_id,
            token_name="",
            operation_type="revoke",
            operation_key=operation_key,
            desired_model_ids=desired_model_ids,
            desired_expires_at=existing.expires_at,
            policy_revision=policy_revision,
        )

    def _enqueue_unidentified_revoke_obligation(
        self,
        existing: AccessRow,
        *,
        tenant_id: str,
        provider_id: str,
        desired_model_ids: list[str] | None = None,
        policy_revision: str,
    ) -> None:
        operation_key = (
            f"relay:reconcile:{tenant_id}:{provider_id}:"
            f"{existing.version}:{policy_revision}"
        )
        prepare = getattr(self._repo, "prepare_unidentified_relay_token_revocation", None)
        if callable(prepare):
            # Production PostgreSQL performs the local fence and obligation
            # insert in one transaction, so a crash cannot leave an unknown
            # legacy token silently active without a durable receipt.
            kwargs = {
                "tenant_id": tenant_id,
                "provider_id": provider_id,
                "newapi_user_id": existing.newapi_user_id,
                "token_name": existing.newapi_username,
                "operation_key": operation_key,
                "desired_model_ids": desired_model_ids or [],
                "desired_expires_at": existing.expires_at,
                "policy_revision": policy_revision,
                "expected_access_version": existing.version,
            }
            prepare(**{
                key: value for key, value in kwargs.items()
                if _accepts_keyword(prepare, key)
            })
            return
        self._mark_local_revoked(tenant_id, provider_id, expected_token_id=None)
        self._ensure_operation(
            tenant_id=tenant_id,
            provider_id=provider_id,
            newapi_user_id=existing.newapi_user_id,
            newapi_token_id=None,
            token_name=existing.newapi_username,
            operation_type="revoke",
            operation_key=operation_key,
            desired_model_ids=desired_model_ids or [],
            desired_expires_at=existing.expires_at,
            policy_revision=policy_revision,
            expected_access_version=existing.version,
            expected_access_token_id=None,
        )

    def _mark_local_revoked(self, tenant_id: str, provider_id: str, *, expected_token_id: int | None) -> None:
        method = getattr(self._repo, "mark_access_revoked", None)
        if callable(method):
            method(tenant_id, provider_id, expected_token_id=expected_token_id)

    def _revoke_upstream(self, access: AccessRow, token_id: int, *, operation: Any | None = None) -> bool:
        if access.newapi_user_id is None:
            raise NewApiError("NewAPI tenant identity is unavailable")
        management_token = self._decrypt_management_token(access)
        revoke = getattr(self._newapi, "revoke_relay_token", None)
        if revoke is None:
            revoke = getattr(self._newapi, "disable_relay_token", None)
        if revoke is None:
            revoke = getattr(self._newapi, "revoke_token", None)
        if callable(revoke):
            def call():
                return revoke(
                    dashboard_token=management_token,
                    user_id=access.newapi_user_id,
                    token_id=token_id,
                )

            result = self._call_upstream(operation, call) if operation is not None else call()
            return result is not False
        update = getattr(self._newapi, "update_relay_token", None)
        if callable(update):
            def call():
                return update(
                    dashboard_token=management_token,
                    user_id=access.newapi_user_id,
                    token_id=token_id,
                    status=2,
                )

            result = self._call_upstream(operation, call) if operation is not None else call()
            return result is not False
        delete = getattr(self._newapi, "delete_relay_token", None)
        if delete is None:
            delete = getattr(self._newapi, "delete_token", None)
        if callable(delete):
            # A delete implementation must reconcile 404/missing before this
            # call or expose missing_ok semantics; never guess by token name.
            kwargs = {
                "dashboard_token": management_token,
                "user_id": access.newapi_user_id,
                "token_id": token_id,
            }
            if _accepts_keyword(delete, "missing_ok"):
                kwargs["missing_ok"] = True
            result = delete(**kwargs)
            return result is not False
        raise NewApiError("NewAPI relay token revocation is unsupported")

    def _mark_lifecycle_revoked(
        self,
        tenant_id: str,
        provider_id: str,
        token_id: int,
        *,
        observed: bool = True,
    ) -> None:
        method = getattr(self._repo, "mark_relay_token_revoked", None)
        if callable(method):
            kwargs = {
                "tenant_id": tenant_id,
                "provider_id": provider_id,
                "newapi_token_id": token_id,
            }
            if _accepts_keyword(method, "observed"):
                kwargs["observed"] = observed
            method(**kwargs)

    def _ensure_operation(self, **values) -> Any:
        key = values["operation_key"]
        method = getattr(self._repo, "ensure_relay_token_operation", None)
        if method is None:
            method = getattr(self._repo, "record_relay_token_operation", None)
        if callable(method):
            filtered = {
                name: value for name, value in values.items()
                if _accepts_keyword(method, name)
            }
            return method(**filtered)
        operation = self._volatile_operations.get(key)
        if operation is None:
            operation = {
                **values,
                "status": "pending",
                "attempt_count": 0,
                "operation_id": key,
            }
            self._volatile_operations[key] = operation
        return operation

    @staticmethod
    def _operation_status(operation: Any) -> str:
        if operation is None:
            return "pending"
        return str(operation.get("status") if isinstance(operation, dict) else getattr(operation, "status", "pending"))

    def _claim_operation(self, operation: Any, *, force: bool = False) -> Any | None:
        """Claim one inline receipt; a live claimant blocks duplicate issue."""
        operation_id = self._operation_id(operation)
        method = getattr(self._repo, "claim_relay_token_operation", None)
        if callable(method) and operation_id:
            claim_owner = self._new_claim_owner()
            kwargs: dict[str, Any] = {"force": force}
            owner_cas = _accepts_keyword(method, "claim_owner")
            if owner_cas:
                kwargs["claim_owner"] = claim_owner
            if not _accepts_keyword(method, "force"):
                kwargs.pop("force")
            claimed = method(operation_id, **kwargs)
            if claimed is True:
                claimed = operation
            if claimed is False:
                return None
            if claimed is None:
                return None
            if owner_cas:
                returned_owner = self._operation_claim_owner(claimed)
                if returned_owner is not None and returned_owner != claim_owner:
                    raise NewApiError("relay lifecycle claim owner mismatch")
                if returned_owner is None:
                    raise NewApiError("relay lifecycle claim owner is unavailable")
            else:
                self._set_dict_claim_owner(claimed, claim_owner)
            return claimed
        if isinstance(operation, dict):
            status = str(operation.get("status", "pending"))
            if status == "succeeded":
                return None
            if status == "running":
                return None
            operation["status"] = "running"
            operation["attempt_count"] = int(operation.get("attempt_count", 0)) + 1
            operation["claim_owner"] = self._new_claim_owner()
            return operation
        return operation if self._operation_status(operation) not in {"running", "succeeded"} else None

    def heartbeat_relay_token_operation(self, operation: Any) -> Any | None:
        """Heartbeat a live durable claim using its per-claim owner nonce."""
        operation_id = self._operation_id(operation)
        owner = self._operation_claim_owner(operation)
        method = getattr(self._repo, "heartbeat_relay_token_operation", None)
        if callable(method) and operation_id:
            if owner is None:
                return None
            kwargs = self._owner_kwargs(operation, method)
            return method(operation_id, **kwargs)
        if isinstance(operation, dict) and operation.get("status") == "running":
            if owner is None:
                return None
            lease_until = operation.get("lease_until")
            if isinstance(lease_until, datetime):
                if lease_until.tzinfo is None:
                    lease_until = lease_until.replace(tzinfo=UTC)
                if lease_until.astimezone(UTC) <= self._now():
                    return None
            operation["heartbeat_at"] = self._now()
            return operation
        return None

    def _call_upstream(self, operation: Any, callback: Callable[[], Any]) -> Any:
        """Run one upstream action while retaining the claim lease."""
        if (
            isinstance(operation, dict)
            and self._operation_status(operation) == "running"
            and self._operation_claim_owner(operation) is None
        ):
            # Lightweight in-memory doubles do not return a claimed row; give
            # their already-running operation the same per-claim identity that
            # PostgreSQL returns from its UPDATE ... RETURNING statement.
            self._set_dict_claim_owner(operation, self._new_claim_owner())
        requires_lease = self._operation_id(operation) and self._operation_status(operation) == "running"
        if requires_lease and self.heartbeat_relay_token_operation(operation) is None:
            raise NewApiError("relay lifecycle operation lease is no longer owned")

        heartbeat_stop = threading.Event()
        heartbeat_lost = threading.Event()
        heartbeat_thread: threading.Thread | None = None

        def heartbeat_loop() -> None:
            while not heartbeat_stop.wait(self._heartbeat_interval):
                try:
                    if self.heartbeat_relay_token_operation(operation) is None:
                        heartbeat_lost.set()
                        return
                except Exception:
                    # A failed refresh leaves ownership unknown.  Fail closed
                    # after the callback rather than allowing stale publication.
                    heartbeat_lost.set()
                    return

        def stop_heartbeat() -> None:
            if heartbeat_thread is None:
                return
            heartbeat_stop.set()
            heartbeat_thread.join()

        if requires_lease:
            heartbeat_thread = threading.Thread(
                target=heartbeat_loop,
                name="relay-claim-heartbeat",
                daemon=True,
            )
            heartbeat_thread.start()
        try:
            result = callback()
        except BaseException:
            stop_heartbeat()
            # A failed action is still an uncertain outcome; best-effort lease
            # refresh keeps the receipt recoverable by this owner until the
            # caller records its bounded backoff.
            try:
                self.heartbeat_relay_token_operation(operation)
            except Exception:
                pass
            raise
        stop_heartbeat()
        if requires_lease and heartbeat_lost.is_set():
            observed_token_id = None
            if isinstance(result, tuple) and result and isinstance(result[0], int):
                observed_token_id = result[0]
            raise NewApiError(
                "relay lifecycle operation lease expired during upstream work",
                token_id=observed_token_id,
            )
        if requires_lease and self.heartbeat_relay_token_operation(operation) is None:
            observed_token_id = None
            if isinstance(result, tuple) and result and isinstance(result[0], int):
                observed_token_id = result[0]
            raise NewApiError(
                "relay lifecycle operation lease expired during upstream work",
                token_id=observed_token_id,
            )
        return result

    @staticmethod
    def _operation_id(operation: Any) -> str:
        value = operation.get("operation_id") if isinstance(operation, dict) else getattr(operation, "operation_id", None)
        return str(value) if value is not None else ""

    def _bind_operation(self, operation: Any, token_id: int) -> None:
        operation_id = self._operation_id(operation)
        method = getattr(self._repo, "bind_relay_token_operation", None)
        if callable(method) and operation_id:
            owner_cas = _accepts_keyword(method, "claim_owner")
            kwargs = self._owner_kwargs(operation, method) if owner_cas else {}
            result = method(operation_id, token_id, **kwargs)
            if owner_cas and result is None:
                raise NewApiError("relay lifecycle issue receipt claim is stale", token_id=token_id)
        elif isinstance(operation, dict):
            operation["newapi_token_id"] = token_id

    def _mark_operation_succeeded(self, operation: Any) -> None:
        operation_id = self._operation_id(operation)
        method = getattr(self._repo, "mark_relay_token_operation_succeeded", None)
        if callable(method) and operation_id:
            owner_cas = _accepts_keyword(method, "claim_owner")
            kwargs = self._owner_kwargs(operation, method) if owner_cas else {}
            result = method(operation_id, **kwargs)
            if owner_cas and result is None:
                raise NewApiError("relay lifecycle receipt completion is stale")
        elif isinstance(operation, dict):
            operation["status"] = "succeeded"
            operation["completed_at"] = self._now()

    def _mark_operation_failed(self, operation: Any, error: Exception) -> None:
        operation_id = self._operation_id(operation)
        attempts = operation.get("attempt_count", 0) if isinstance(operation, dict) else getattr(operation, "attempt_count", 0)
        retry_at = self._now() + min(
            RELAY_TOKEN_RETRY_BASE * (2 ** min(int(attempts), 8)),
            RELAY_TOKEN_RETRY_MAX,
        )
        method = getattr(self._repo, "mark_relay_token_operation_failed", None)
        if callable(method) and operation_id:
            kwargs = {"error": _safe_lifecycle_error(error), "next_attempt_at": retry_at}
            if _accepts_keyword(method, "increment_attempt"):
                kwargs["increment_attempt"] = self._operation_status(operation) != "running"
            kwargs.update(self._owner_kwargs(operation, method))
            method(operation_id, **kwargs)
        elif isinstance(operation, dict):
            operation["status"] = "failed"
            operation["attempt_count"] = int(attempts) + 1
            operation["next_attempt_at"] = retry_at
            operation["last_error"] = _safe_lifecycle_error(error)

    def recover_relay_token_operations(
        self,
        *,
        limit: int = 100,
        force: bool = False,
        tenant_id: str | None = None,
        provider_id: str | None = None,
    ) -> dict[str, int]:
        """Retry durable upstream lifecycle receipts after restart/outage."""
        claim = getattr(self._repo, "claim_relay_token_operations", None)
        if claim is None:
            claim = getattr(self._repo, "claim_due_relay_token_operations", None)
        if callable(claim):
            claim_kwargs = {"limit": limit, "force": force, "tenant_id": tenant_id, "provider_id": provider_id}
            if not _accepts_keyword(claim, "force"):
                claim_kwargs.pop("force")
            if not _accepts_keyword(claim, "tenant_id"):
                claim_kwargs.pop("tenant_id")
            if not _accepts_keyword(claim, "provider_id"):
                claim_kwargs.pop("provider_id")
            operations = claim(**claim_kwargs) or []
        else:
            now = self._now()
            operations = [
                value for value in self._volatile_operations.values()
                if value.get("status") != "succeeded"
                and (force or value.get("next_attempt_at") is None or value["next_attempt_at"] <= now)
                and (tenant_id is None or value.get("tenant_id") == tenant_id)
                and (provider_id is None or value.get("provider_id") == provider_id)
            ][:limit]
        operations = [self._ensure_claim_owner(operation) for operation in operations]
        result = {"processed": 0, "succeeded": 0, "failed": 0}
        for operation in operations:
            result["processed"] += 1
            try:
                self._recover_operation(operation)
            except Exception as exc:
                result["failed"] += 1
                self._mark_operation_failed(operation, exc if isinstance(exc, Exception) else Exception("unknown"))
            else:
                result["succeeded"] += 1
                if _operation_text(operation, "operation_type") == "bootstrap":
                    self._set_bootstrap_progress(operation, bootstrap_state="completed")
                self._mark_operation_succeeded(operation)
        return result

    # Explicit aliases used by maintenance jobs and older callers.
    retry_failed_lifecycle_operations = recover_relay_token_operations
    recover_relay_token_lifecycle = recover_relay_token_operations

    def _recovery_allowed_models(self, tenant_id: str, provider_id: str) -> set[str]:
        """Re-read provider publication and policy before replaying an issue."""
        return self._current_effective_models(tenant_id, provider_id)

    def _assert_relay_cleanup_clear(self, tenant_id: str, provider_id: str) -> None:
        """Block a new generation while a known upstream cleanup is pending."""
        listing = getattr(self._repo, "list_relay_token_operations", None)
        if not callable(listing):
            return
        kwargs: dict[str, Any] = {}
        if _accepts_keyword(listing, "tenant_id"):
            kwargs["tenant_id"] = tenant_id
        if _accepts_keyword(listing, "provider_id"):
            kwargs["provider_id"] = provider_id
        try:
            operations = listing(**kwargs) or []
        except Exception as exc:
            raise Conflict("tenant relay token cleanup status is unavailable") from exc
        for operation in operations:
            if (
                _operation_text(operation, "operation_type") in {"revoke", "delete"}
                and _operation_text(operation, "status") != "succeeded"
            ):
                raise Conflict("tenant relay token cleanup is pending")

    def _recover_operation(self, operation: Any) -> None:
        operation_type = _operation_text(operation, "operation_type")
        tenant_id = _operation_text(operation, "tenant_id")
        provider_id = _operation_text(operation, "provider_id")
        if not tenant_id or not provider_id:
            raise NewApiError("relay lifecycle receipt has invalid scope")
        token_id = _operation_optional_int(operation, "newapi_token_id")
        access = self._repo.get_access(tenant_id, provider_id)
        if access is None:
            if operation_type == "issue" and token_id is not None:
                self._reconcile_superseded_issue_token(
                    operation,
                    None,
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    token_id=token_id,
                )
                raise NewApiError("relay token issue receipt was superseded", token_id=token_id)
            if operation_type == "revoke":
                # Local access was already removed; upstream identity is still
                # required to retry, so do not claim success by guessing.
                raise NewApiError("tenant relay access identity is unavailable")
            raise NewApiError("tenant relay access is unavailable")
        if operation_type == "bootstrap":
            self._recover_bootstrap_operation(operation, access)
            return
        if (
            operation_type in {"revoke", "delete"}
            and token_id is not None
            and access.status == "active"
            and access.newapi_token_id == token_id
            and self._access_is_effective(access)
        ):
            self._cancel_adopted_revoke(
                tenant_id=tenant_id,
                provider_id=provider_id,
                token_id=token_id,
                exclude_operation_id=self._operation_id(operation),
            )
            return
        user_id = _operation_optional_int(operation, "newapi_user_id")
        if operation_type == "issue":
            expected_version = _operation_optional_int(operation, "expected_access_version")
            expected_token_id = _operation_optional_int(operation, "expected_access_token_id")
            if expected_version is None:
                raise NewApiError("relay token issue receipt lacks a valid access CAS")
            if access.version != expected_version or access.newapi_token_id != expected_token_id:
                if token_id is not None:
                    self._reconcile_superseded_issue_token(
                        operation,
                        access,
                        tenant_id=tenant_id,
                        provider_id=provider_id,
                        token_id=token_id,
                    )
                raise NewApiError("relay token issue receipt was superseded", token_id=token_id)
            token_name = _operation_text(operation, "token_name")
            desired = _operation_models(operation, "desired_model_ids")
            expires_at = _operation_datetime(operation, "desired_expires_at")
            if expires_at is not None and expires_at <= self._now():
                if token_id is not None:
                    still_effective_adoption = (
                        access.status == "active"
                        and access.newapi_token_id == token_id
                        and self._access_is_effective(access)
                    )
                    self._reconcile_superseded_issue_token(
                        operation,
                        access,
                        tenant_id=tenant_id,
                        provider_id=provider_id,
                        token_id=token_id,
                    )
                    if not still_effective_adoption and access.status == "active" and access.newapi_token_id == token_id:
                        try:
                            self._mark_local_revoked(
                                tenant_id, provider_id, expected_token_id=token_id,
                            )
                        except Exception:
                            pass
                raise NewApiError(
                    "relay lifecycle issue receipt expired",
                    token_id=token_id,
                )
            current_allowed = self._recovery_allowed_models(tenant_id, provider_id)
            if not desired or not set(desired) <= current_allowed:
                raise NewApiError("relay lifecycle issue policy is no longer current")
            recorded_policy = _operation_text(operation, "policy_revision")
            if (
                self._allowed_model_refs(tenant_id) is not None
                and recorded_policy != self._policy_revision(provider_id, sorted(current_allowed))
            ):
                raise NewApiError("relay lifecycle issue policy revision is no longer current")
            if user_id is None:
                user_id = access.newapi_user_id
            if user_id is None:
                raise NewApiError("NewAPI tenant identity is unavailable")
            management_token = self._decrypt_management_token(access)
            if expires_at is None:
                expires_at = self._now() + self._token_lifetime
            created_token_id: int | None = None
            try:
                new_token_id, relay_token = self._issue_relay_token(
                    operation,
                    dashboard_token=management_token,
                    user_id=user_id,
                    name=token_name,
                    model_ids=desired,
                    expired_time=int(expires_at.timestamp()),
                )
                created_token_id = new_token_id
                self._bind_operation(operation, new_token_id)
                self._assert_policy_for_commit(
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    allowed_model_ids=desired,
                    policy_revision=_operation_text(operation, "policy_revision"),
                )
                self._persist_access(
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    relay_token=relay_token,
                    management_token=management_token,
                    allowed_model_ids=desired,
                    username=access.newapi_username,
                    user_id=user_id,
                    token_id=new_token_id,
                    expires_at=expires_at,
                    policy_revision=_operation_text(operation, "policy_revision"),
                    token_name=token_name,
                    old_access=access,
                    operation=operation,
                )
            except NewApiError as exc:
                safe = exc
                if safe.token_id is None and created_token_id is not None:
                    safe = NewApiError(str(exc), token_id=created_token_id)
                self._reconcile_failed_issue(
                    operation,
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    management_token=management_token,
                    user_id=user_id,
                    token_name=token_name,
                    allowed_model_ids=desired,
                    expires_at=expires_at,
                    policy_revision=_operation_text(operation, "policy_revision"),
                    error=safe,
                )
                raise safe from exc
            except Exception as exc:
                safe = NewApiError(
                    "NewAPI relay token issue outcome is unknown",
                    token_id=created_token_id,
                )
                self._reconcile_failed_issue(
                    operation,
                    tenant_id=tenant_id,
                    provider_id=provider_id,
                    management_token=management_token,
                    user_id=user_id,
                    token_name=token_name,
                    allowed_model_ids=desired,
                    expires_at=expires_at,
                    policy_revision=_operation_text(operation, "policy_revision"),
                    error=safe,
                )
                raise safe from exc
            return
        if token_id is None:
            raise NewApiError("relay lifecycle receipt has no token id")
        if operation_type == "update":
            update = getattr(self._newapi, "update_relay_token", None)
            if update is None:
                update = getattr(self._newapi, "update_token", None)
            if not callable(update) or access.newapi_user_id is None:
                raise NewApiError("NewAPI relay token update is unsupported")
            expires_at = _operation_datetime(operation, "desired_expires_at")
            self._call_upstream(
                operation,
                lambda: update(
                    dashboard_token=self._decrypt_management_token(access),
                    user_id=access.newapi_user_id,
                    token_id=int(token_id),
                    model_ids=_operation_models(operation, "desired_model_ids"),
                    expired_time=int(expires_at.timestamp()) if expires_at is not None else None,
                ),
            )
            self._record_relay_token(
                tenant_id=tenant_id,
                provider_id=provider_id,
                newapi_user_id=access.newapi_user_id,
                newapi_token_id=int(token_id),
                token_name=_operation_text(operation, "token_name"),
                allowed_model_ids=_operation_models(operation, "desired_model_ids"),
                expires_at=expires_at,
                policy_revision=_operation_text(operation, "policy_revision"),
            )
            return
        # Revoke/delete receipts always use the current encrypted management
        # credential but the recorded token id; never infer an id by name.
        if operation_type == "delete":
            observed = self._delete_upstream(access, int(token_id), operation=operation)
        else:
            observed = self._revoke_upstream(access, int(token_id), operation=operation)
        self._mark_lifecycle_revoked(tenant_id, provider_id, int(token_id), observed=observed)

    def _recover_bootstrap_operation(self, operation: Any, access: AccessRow) -> None:
        """Finish a staged user bootstrap and reconcile additive quota safely."""
        state = _operation_text(operation, "bootstrap_state", "planned")
        user_id = access.newapi_user_id
        try:
            management_token = self._decrypt_management_token(access)
        except NewApiError:
            password = self._decrypt_bootstrap_password(access)
            username = _operation_text(operation, "token_name") or access.newapi_username
            user_id = self._ensure_bootstrap_user(
                operation,
                tenant_id=access.tenant_id,
                username=username,
                password=password,
            )
            self._set_bootstrap_identity(
                tenant_id=access.tenant_id,
                provider_id=access.provider_id,
                user_id=int(user_id),
            )
            if state == "planned":
                self._set_bootstrap_progress(operation, bootstrap_state="user_created")
                state = "user_created"
            dashboard_token, login_user_id = self._call_upstream(
                operation,
                lambda: self._newapi.login(username, password),
            )
            if int(login_user_id) != int(user_id):
                raise NewApiError("NewAPI tenant identity mismatch")
            if state == "quota_pending":
                quota_before = _operation_optional_int(operation, "quota_before")
                quota_delta = _operation_optional_int(operation, "quota_delta")
                if quota_before is None or quota_delta is None or quota_delta <= 0:
                    raise NewApiError("relay tenant bootstrap quota receipt is incomplete")
                current_quota = self._call_upstream(
                    operation,
                    lambda: self._newapi.get_user_quota(
                        dashboard_token=dashboard_token, user_id=int(user_id),
                    ),
                )
                target = quota_before + quota_delta
                if current_quota >= target:
                    self._set_bootstrap_progress(operation, bootstrap_state="quota_applied")
                    state = "quota_applied"
                elif current_quota == quota_before:
                    self._call_upstream(
                        operation,
                        lambda: self._newapi.add_user_quota(int(user_id), quota_delta),
                    )
                    self._set_bootstrap_progress(operation, bootstrap_state="quota_applied")
                    state = "quota_applied"
                else:
                    raise NewApiError("NewAPI tenant quota outcome is ambiguous")
            elif state not in {"quota_applied", "management_ready", "completed"}:
                quota_before = self._call_upstream(
                    operation,
                    lambda: self._newapi.get_user_quota(
                        dashboard_token=dashboard_token, user_id=int(user_id),
                    ),
                )
                if quota_before < 0:
                    raise NewApiError("NewAPI tenant quota is invalid")
                self._set_bootstrap_progress(
                    operation,
                    bootstrap_state="quota_pending",
                    quota_before=quota_before,
                    quota_delta=RELAY_TENANT_INITIAL_QUOTA,
                )
                self._call_upstream(
                    operation,
                    lambda: self._newapi.add_user_quota(int(user_id), RELAY_TENANT_INITIAL_QUOTA),
                )
                self._set_bootstrap_progress(operation, bootstrap_state="quota_applied")
                state = "quota_applied"
            management_token = self._call_upstream(
                operation,
                lambda: self._newapi.generate_management_token(dashboard_token, int(user_id)),
            )
        if user_id is None:
            raise NewApiError("NewAPI tenant identity is unavailable")
        self._complete_bootstrap(
            tenant_id=access.tenant_id,
            provider_id=access.provider_id,
            user_id=int(user_id),
            management_token=management_token,
            allowed_model_ids=_operation_models(operation, "desired_model_ids"),
            username=access.newapi_username,
            policy_revision=_operation_text(operation, "policy_revision"),
        )
        self._set_bootstrap_progress(operation, bootstrap_state="management_ready")

    def _delete_upstream(self, access: AccessRow, token_id: int, *, operation: Any | None = None) -> bool:
        if access.newapi_user_id is None:
            raise NewApiError("NewAPI tenant identity is unavailable")
        management_token = self._decrypt_management_token(access)
        delete = getattr(self._newapi, "delete_relay_token", None)
        if delete is None:
            delete = getattr(self._newapi, "delete_token", None)
        if callable(delete):
            kwargs = {
                "dashboard_token": management_token,
                "user_id": access.newapi_user_id,
                "token_id": token_id,
            }
            if _accepts_keyword(delete, "missing_ok"):
                kwargs["missing_ok"] = True
            def call():
                return delete(**kwargs)

            result = self._call_upstream(operation, call) if operation is not None else call()
            return result is not False
        # The pinned contract also supports status-only disable.  Falling back
        # to it keeps an unavailable DELETE adapter fail-closed rather than
        # pretending deletion succeeded.
        return self._revoke_upstream(access, token_id, operation=operation)

    def access_metadata(self, tenant_id: str, provider_id: str) -> TenantProviderAccess:
        access = self._repo.get_access(tenant_id, provider_id)
        if not access:
            raise NotFound("tenant provider access not found")
        return _access(access)

    def _runtime_access(self, provider: ProviderRow, access: AccessRow) -> dict:
        if access.status != "active":
            raise Conflict("tenant provider access is revoked")
        if not self._access_is_effective(access):
            raise Conflict("tenant provider access has expired")
        try:
            relay_token = self._crypto.decrypt(access.encrypted_token)
        except Exception as exc:
            raise Conflict("tenant provider access is unavailable") from exc
        if not isinstance(relay_token, str) or not relay_token:
            raise Conflict("tenant provider access is unavailable")
        return {
            "access": _access(access),
            "relay_base_url": self._public_relay_url,
            "api_protocol": provider.api_protocol,
            "relay_token": relay_token,
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


def _relay_token_name(tenant_id: str, provider_code: str, generation: int) -> str:
    """Keep the generation suffix inside NewAPI's bounded token-name field."""
    suffix = f"-v{generation}"
    prefix = f"aiteam-{tenant_id[:8]}-{provider_code}"
    if len(suffix) >= 30:
        return suffix[-30:]
    return prefix[:30 - len(suffix)] + suffix


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
    # The guard above is intentionally explicit so the values below are
    # narrowed for type checkers without ever logging or copying secrets.
    assert settings.db_url and admin_url and public_url and admin_token and admin_user_id and encryption_key
    from .repository import PgEnterpriseRepository

    return PlatformProviderService(
        PlatformProviderRepository(settings.db_url),
        NewApiAdminClient(admin_url, admin_token, admin_user_id, timeout=settings.service_client_timeout_ms / 1000),
        CryptoService(Fernet(encryption_key.encode())),
        public_url,
        ModelsDevPricingClient(os.getenv("MODEL_PRICING_URL", "https://models.dev/api.json"), timeout=settings.service_client_timeout_ms / 1000),
        enterprise_repository=PgEnterpriseRepository(settings.db_url),
    )


def install_relay_token_lifecycle_lifespan(
    app,
    *,
    interval_seconds: int = RELAY_TOKEN_RECOVERY_INTERVAL_SECONDS,
    batch_limit: int = RELAY_TOKEN_RECOVERY_BATCH_LIMIT,
) -> None:
    """Install a bounded background recovery loop for dormant tenant receipts.

    Operation currently has no separate worker process.  This small lifespan
    seam keeps failed lifecycle writes recoverable after restart without
    adding a queue or making readiness depend on NewAPI availability.
    """
    original = app.router.lifespan_context
    interval_seconds = max(5, int(interval_seconds))
    batch_limit = max(1, min(int(batch_limit), 100))

    @asynccontextmanager
    async def lifespan(instance):
        async with original(instance):
            stop = asyncio.Event()

            async def poll() -> None:
                while not stop.is_set():
                    service = getattr(instance.state, "_platform_provider_service", None)
                    if service is None:
                        try:
                            service = build_platform_provider_service()
                            instance.state._platform_provider_service = service
                        except Exception:
                            service = None
                    recover = getattr(service, "recover_relay_token_operations", None) if service is not None else None
                    if callable(recover):
                        try:
                            await asyncio.to_thread(recover, limit=batch_limit)
                        except Exception:
                            # Upstream outages remain a degraded dependency;
                            # the durable receipt/backoff is the source of truth.
                            logger.warning("relay lifecycle recovery sweep failed", exc_info=True)
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=interval_seconds)
                    except TimeoutError:
                        continue

            task = asyncio.create_task(poll())
            try:
                yield
            finally:
                stop.set()
                await task

    app.router.lifespan_context = lifespan


def _remote_token_id(item: Any) -> int | None:
    if not isinstance(item, dict) or item.get("id") is None:
        return None
    try:
        return int(str(item["id"]))
    except (TypeError, ValueError):
        return None


def _operation_value(operation: Any, name: str, default: Any = None) -> Any:
    if isinstance(operation, dict):
        return operation.get(name, default)
    return getattr(operation, name, default)


def _operation_text(operation: Any, name: str, default: str = "") -> str:
    value = _operation_value(operation, name, default)
    return value if isinstance(value, str) else default


def _operation_optional_int(operation: Any, name: str) -> int | None:
    value = _operation_value(operation, name)
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise NewApiError(f"relay lifecycle receipt has invalid {name}") from exc


def _operation_models(operation: Any, name: str) -> list[str]:
    value = _operation_value(operation, name, [])
    if not isinstance(value, (list, tuple)):
        raise NewApiError(f"relay lifecycle receipt has invalid {name}")
    return [item for item in value if isinstance(item, str) and item.strip()]


def _operation_datetime(operation: Any, name: str) -> datetime | None:
    value = _operation_value(operation, name)
    if value is None or isinstance(value, datetime):
        return value
    raise NewApiError(f"relay lifecycle receipt has invalid {name}")


def _accepts_keyword(callable_obj, name: str) -> bool:
    """Whether an injected repository method accepts an additive keyword."""
    try:
        signature = inspect.signature(callable_obj)
    except (TypeError, ValueError):
        return True
    return name in signature.parameters or any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in signature.parameters.values()
    )


def _safe_lifecycle_error(error: Exception) -> str:
    """Bound lifecycle receipts to non-secret, operator-safe diagnostics."""
    text = str(error).replace("\n", " ")
    text = re.sub(r"(?i)bearer\s+[^\s,;]+", "Bearer [redacted]", text)
    text = re.sub(r"(?i)sk-[A-Za-z0-9._~+/=-]+", "[redacted]", text)
    text = re.sub(r"(?i)(token|key|password|secret)\s*[:=]\s*[^\s,;]+", r"\1=[redacted]", text)
    return text[:500] or error.__class__.__name__


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
