import json
from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest

from operation_service.newapi_client import NewApiAdminClient, NewApiError
from operation_service.platform_provider_repository import AccessRow, ModelRow, ProviderRow, RateRow
from operation_service.platform_provider_service import PlatformProviderService, newapi_urls
from shared.errors import Conflict
from shared.contracts.platform_provider import PlatformModelRef
from operation_service.public_pricing_client import ModelsDevPricingClient, PublicModelPrice, PublicPricingError, _model_capabilities


def test_newapi_url_is_configurable_like_other_manager_services(monkeypatch):
    monkeypatch.setenv("NEWAPI_URL", "https://relay.example/ai")
    monkeypatch.delenv("NEWAPI_ADMIN_BASE_URL", raising=False)
    monkeypatch.delenv("NEWAPI_PUBLIC_BASE_URL", raising=False)
    assert newapi_urls() == ("https://relay.example/ai", "https://relay.example/ai/v1")


def test_explicit_newapi_urls_override_common_base(monkeypatch):
    monkeypatch.setenv("NEWAPI_URL", "https://relay.example/ai")
    monkeypatch.setenv("NEWAPI_ADMIN_BASE_URL", "http://newapi:3000")
    monkeypatch.setenv("NEWAPI_PUBLIC_BASE_URL", "https://relay.example/v1")
    assert newapi_urls() == ("http://newapi:3000", "https://relay.example/v1")


def test_models_dev_client_selects_canonical_prices_and_skips_free_entries():
    payload = {
        "thirdparty": {"models": {"gpt-5.5": {"id": "gpt-5.5", "cost": {"input": 1, "output": 2}}}},
        "openai": {"models": {"gpt-5.5": {"id": "gpt-5.5", "cost": {"input": 5, "output": 30, "cache_read": 0.5}}}},
        "minimax": {"models": {"MiniMax-M3": {
            "id": "MiniMax-M3", "name": "MiniMax M3", "reasoning": True,
            "reasoning_options": [{"type": "toggle"}],
            "cost": {"input": 0.3, "output": 1.2},
        }}},
        "free": {"models": {"free-model": {"id": "free-model", "cost": {"input": 0, "output": 0}}}},
    }
    client = ModelsDevPricingClient("https://models.dev/api.json", transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=payload)))
    prices = client.fetch()
    assert prices["gpt-5.5"].input_usd_per_million == 5
    assert prices["minimax-m3"].output_usd_per_million == Decimal("1.2")
    assert prices["minimax-m3"].display_name == "MiniMax M3"
    assert prices["minimax-m3"].capabilities["thinking_mode"] == "toggle"
    assert prices["minimax-m3"].capabilities["thinking_levels"] == ["off", "high"]
    assert prices["minimax-m3"].capabilities["thinking_level_map"]["minimal"] is None
    assert "free-model" not in prices


def test_models_dev_reasoning_metadata_normalizes_supported_levels():
    assert _model_capabilities({}) == {}
    assert _model_capabilities({"reasoning": False})["thinking_levels"] == ["off"]
    assert _model_capabilities({
        "reasoning": True,
        "reasoning_options": [{"type": "effort", "values": ["none", "low", "high", "unsupported", 1]}],
    })["thinking_levels"] == ["off", "low", "high"]
    assert _model_capabilities({
        "reasoning": True,
        "reasoning_options": [{"type": "other"}, "bad"],
    })["thinking_levels"] == ["off", "minimal", "low", "medium", "high"]
    assert _model_capabilities({"reasoning": True})["thinking_levels"] == ["off", "minimal", "low", "medium", "high"]
    assert _model_capabilities({"reasoning": True, "reasoning_options": [{"type": "toggle"}]})["thinking_levels"] == ["off", "high"]


def test_internal_provider_bootstrap_syncs_the_deployment_owned_channel():
    now = datetime.now(UTC)
    provider = ProviderRow("p1", "newapi", "LLM 网关", "http://relay/v1", "openai-completions", 1, "published", 1, now)
    rate = RateRow("r1", "p1", "minimax-m3", 1, "known", "token", Decimal("0.3"), Decimal("1.2"), None, None, None, "USD", "public_reference", "models.dev/api.json", now, None, False)
    seen = {}
    published = []

    class Repo:
        def ensure_internal_provider(self, **values):
            seen.update(values)
            return provider

        def list_providers(self, **_):
            return [provider]

        def get_provider(self, _provider_id):
            return provider

        def current_rate(self, *_):
            return rate

        def publish_priced_models(self, provider_id):
            published.append(provider_id)
            return []

        def upsert_discovered_models(self, provider_id, model_ids):
            assert provider_id == "p1"
            assert model_ids == ["minimax-m3"]
            return [ModelRow("p1", "minimax-m3", "", {}, "draft", "discovery", 1, now)]

    class NewAPI:
        def get_channel_models(self, channel_id):
            assert channel_id == 1
            return ["minimax-m3"]

    service = PlatformProviderService(Repo(), NewAPI(), None, "http://relay/v1")
    result = service.ensure_internal_provider()
    assert result.provider_code == "newapi"
    assert service.list_providers()[0].provider_code == "newapi"
    assert service.sync_models("p1")[0].model_id == "minimax-m3"
    assert seen["display_name"] == "LLM 网关"
    assert seen["newapi_channel_id"] == 1
    assert published == ["p1", "p1"]


def test_internal_provider_sync_reports_gateway_discovery_errors():
    provider = ProviderRow("p1", "newapi", "LLM 网关", "http://relay/v1", "openai-completions", 1, "published", 1, datetime.now(UTC))

    class Repo:
        def get_provider(self, _): return provider

    class NewAPI:
        def get_channel_models(self, _): raise NewApiError("upstream unavailable")

    service = PlatformProviderService(Repo(), NewAPI(), None, "http://relay/v1")
    with pytest.raises(Conflict, match="LLM 网关 model discovery failed"):
        service.sync_models("p1")


def test_internal_provider_sync_rejects_an_empty_gateway_model_list():
    provider = ProviderRow("p1", "newapi", "LLM 网关", "http://relay/v1", "openai-completions", 1, "published", 1, datetime.now(UTC))

    class Repo:
        def get_provider(self, _): return provider

    class NewAPI:
        def get_channel_models(self, _): return []

    service = PlatformProviderService(Repo(), NewAPI(), None, "http://relay/v1")
    with pytest.raises(Conflict, match="LLM 网关 discovered no models"):
        service.sync_models("p1")


def test_internal_provider_sync_requires_the_deployment_channel_mapping():
    provider = ProviderRow("p1", "newapi", "LLM 网关", "http://relay/v1", "openai-completions", None, "published", 1, datetime.now(UTC))

    class Repo:
        def get_provider(self, _provider_id):
            return provider

    service = PlatformProviderService(Repo(), None, None, "http://relay/v1")
    with pytest.raises(Conflict, match="LLM 网关 channel is not configured"):
        service.sync_models("p1")


def test_public_price_sync_only_fills_unpriced_models():
    provider = ProviderRow("p1", "newapi", "LLM 网关", "http://old/v1", "openai-completions", 1, "draft", 1, datetime.now(UTC))
    model = ModelRow("p1", "gpt-5.5", "", {}, "draft", "discovery", 1, datetime.now(UTC))

    class Repo:
        def get_provider(self, _provider_id): return provider
        def list_models(self, _provider_id, **_): return [model]
        def current_rate(self, *_): return None

    class Pricing:
        def fetch(self):
            return {"gpt-5.5": PublicModelPrice(Decimal("5"), Decimal("30"), Decimal("0.5"))}

    service = PlatformProviderService(Repo(), None, None, "https://relay/v1", Pricing())
    captured = []
    service.set_rate = lambda _provider_id, _model_id, **values: captured.append(values)
    assert service.sync_public_prices("p1") == {"source": "models.dev", "updated": 1, "skipped_known": 0, "skipped_manual": 0, "unmatched": 0}
    assert captured[0]["source"] == "public_reference"
    assert captured[0]["input_usd_per_million"] == Decimal("5")


def test_internal_provider_bootstrap_enriches_model_capabilities():
    now = datetime.now(UTC)
    provider = ProviderRow("p1", "newapi", "LLM 网关", "http://relay/v1", "openai-completions", 1, "published", 1, now)
    model = ModelRow("p1", "minimax-m3", "", {}, "published", "discovery", 1, now)
    missing = ModelRow("p1", "not-in-public-catalog", "", {}, "published", "discovery", 1, now)
    rate = RateRow("r1", "p1", "minimax-m3", 1, "known", "token", Decimal("0.3"), Decimal("1.2"), None, None, None, "USD", "public_reference", "models.dev/api.json", now, None, False)
    enriched = []

    class Repo:
        def ensure_internal_provider(self, **_): return provider
        def get_provider(self, _): return provider
        def upsert_discovered_models(self, *_): return [model, missing]
        def current_rate(self, _provider_id, model_id): return rate if model_id == "minimax-m3" else rate
        def update_model_metadata(self, provider_id, model_id, **values): enriched.append((provider_id, model_id, values)); return model
        def publish_priced_models(self, _): return []

    class NewAPI:
        def get_channel_models(self, _): return ["minimax-m3"]

    class Pricing:
        def fetch(self):
            return {"minimax-m3": PublicModelPrice(
                Decimal("0.3"), Decimal("1.2"),
                display_name="MiniMax M3",
                capabilities={"reasoning": True, "thinking_levels": ["off", "high"]},
            )}

    service = PlatformProviderService(Repo(), NewAPI(), None, "http://relay/v1", Pricing())
    service.ensure_internal_provider()
    assert enriched == [("p1", "minimax-m3", {
        "display_name": "MiniMax M3",
        "capabilities": {"reasoning": True, "thinking_levels": ["off", "high"]},
    })]


def test_platform_provider_rejects_unsupported_template_thinking_level():
    now = datetime.now(UTC)
    provider = ProviderRow("p1", "newapi", "LLM 网关", "http://relay/v1", "openai-completions", 1, "published", 1, now)
    model = ModelRow(
        "p1", "minimax-m3", "MiniMax M3",
        {"reasoning": True, "thinking_levels": ["off", "high"]},
        "published", "discovery", 1, now,
    )
    rate = RateRow("r1", "p1", "minimax-m3", 1, "known", "token", Decimal("0.3"), Decimal("1.2"), None, None, None, "USD", "public_reference", "models.dev/api.json", now, None, False)

    class Repo:
        def get_provider(self, _): return provider
        def get_model(self, _provider_id, _model_id): return model
        def current_rate(self, _provider_id, _model_id): return rate

    service = PlatformProviderService(Repo(), None, None, "http://relay/v1")
    ref = PlatformModelRef(provider_id="p1", provider_version=1, model_id="minimax-m3", model_version=1)
    service.validate_model_thinking_level(ref, "high", require_published=True)
    with pytest.raises(Conflict, match="not supported"):
        service.validate_model_thinking_level(ref, "low", require_published=True)


def test_platform_provider_thinking_validation_handles_map_and_non_reasoning_model():
    now = datetime.now(UTC)
    provider = ProviderRow("p1", "newapi", "LLM 网关", "http://relay/v1", "openai-completions", 1, "published", 1, now)
    mapping_model = ModelRow(
        "p1", "mapped", "Mapped", {"thinking_level_map": {"off": "none", "high": "high", "low": None}},
        "published", "discovery", 1, now,
    )
    plain_model = ModelRow(
        "p1", "plain", "Plain", {"reasoning": False}, "published", "discovery", 1, now,
    )
    rate = RateRow("r1", "p1", "mapped", 1, "known", "token", Decimal("1"), Decimal("2"), None, None, None, "USD", "manual", None, now, None, False)

    class Repo:
        def get_provider(self, _): return provider
        def get_model(self, _provider_id, model_id): return mapping_model if model_id == "mapped" else plain_model
        def current_rate(self, _provider_id, _model_id): return rate

    service = PlatformProviderService(Repo(), None, None, "http://relay/v1")
    service.validate_model_thinking_level(PlatformModelRef(provider_id="p1", provider_version=1, model_id="mapped", model_version=1), "high", require_published=True)
    with pytest.raises(Conflict, match="does not support thinking"):
        service.validate_model_thinking_level(PlatformModelRef(provider_id="p1", provider_version=1, model_id="plain", model_version=1), "high", require_published=True)


def test_internal_provider_bootstrap_fills_public_prices_and_publishes_priced_models():
    now = datetime.now(UTC)
    provider = ProviderRow("p1", "newapi", "LLM 网关", "http://relay/v1", "openai-completions", 1, "published", 1, now)
    model = ModelRow("p1", "gpt-5.5", "", {}, "draft", "discovery", 1, now)
    seen: list[tuple[str, str]] = []

    class Repo:
        def ensure_internal_provider(self, **_): return provider
        def list_providers(self, **_): return [provider]
        def get_provider(self, _): return provider
        def upsert_discovered_models(self, *_): return [model]
        def list_models(self, *_args, **_kwargs): return [model]
        def current_rate(self, *_): return None
        def publish_priced_models(self, provider_id):
            seen.append(("publish", provider_id))
            return [model]

    class NewAPI:
        def get_channel_models(self, channel_id):
            assert channel_id == 1
            return ["gpt-5.5"]

    class Pricing:
        def fetch(self):
            return {"gpt-5.5": PublicModelPrice(Decimal("5"), Decimal("30"))}

    service = PlatformProviderService(Repo(), NewAPI(), None, "http://relay/v1", Pricing())
    captured = []
    service.set_rate = lambda _provider_id, _model_id, **values: captured.append(values)
    service.ensure_internal_provider()

    assert captured[0]["source"] == "public_reference"
    assert seen == [("publish", "p1")]


def test_internal_provider_bootstrap_survives_public_price_source_outage():
    now = datetime.now(UTC)
    provider = ProviderRow("p1", "newapi", "LLM 网关", "http://relay/v1", "openai-completions", 1, "published", 1, now)
    model = ModelRow("p1", "unpriced", "", {}, "draft", "discovery", 1, now)
    published = []

    class Repo:
        def ensure_internal_provider(self, **_): return provider
        def get_provider(self, _): return provider
        def upsert_discovered_models(self, *_): return [model]
        def current_rate(self, *_): return None
        def list_models(self, *_args, **_kwargs): return [model]
        def update_model_metadata(self, *_args, **_kwargs): raise AssertionError("metadata must not update on outage")
        def publish_priced_models(self, provider_id):
            published.append(provider_id)
            return []

    class NewAPI:
        def get_channel_models(self, _): return ["unpriced"]

    class Pricing:
        def fetch(self): raise PublicPricingError("temporarily unavailable")

    service = PlatformProviderService(Repo(), NewAPI(), None, "http://relay/v1", Pricing())
    assert service.ensure_internal_provider().display_name == "LLM 网关"
    assert published == ["p1"]


def test_manual_public_price_sync_refreshes_changed_public_rates():
    now = datetime.now(UTC)
    provider = ProviderRow("p1", "newapi", "LLM 网关", "http://relay/v1", "openai-completions", 1, "published", 1, now)
    model = ModelRow("p1", "gpt-5.5", "", {}, "published", "discovery", 1, now)
    current = RateRow("r1", "p1", "gpt-5.5", 1, "known", "token", Decimal("5"), Decimal("30"), None, None, None, "USD", "public_reference", "models.dev/api.json", now, None, False)

    class Repo:
        def get_provider(self, _): return provider
        def list_models(self, _provider_id, **_): return [model]
        def current_rate(self, *_): return current

    class Pricing:
        def fetch(self):
            return {"gpt-5.5": PublicModelPrice(Decimal("6"), Decimal("30"))}

    service = PlatformProviderService(Repo(), None, None, "http://relay/v1", Pricing())
    captured = []
    service.set_rate = lambda _provider_id, _model_id, **values: captured.append(values)

    result = service.sync_public_prices("p1", force=True)

    assert result["updated"] == 1
    assert captured[0]["input_usd_per_million"] == Decimal("6")


def test_manual_public_price_sync_skips_unchanged_public_rates():
    now = datetime.now(UTC)
    provider = ProviderRow("p1", "newapi", "LLM 网关", "http://relay/v1", "openai-completions", 1, "published", 1, now)
    model = ModelRow("p1", "gpt-5.5", "", {}, "published", "discovery", 1, now)
    current = RateRow("r1", "p1", "gpt-5.5", 1, "known", "token", Decimal("5"), Decimal("30"), None, None, None, "USD", "public_reference", "models.dev/api.json", now, None, False)

    class Repo:
        def get_provider(self, _): return provider
        def list_models(self, _provider_id, **_): return [model]
        def current_rate(self, *_): return current

    class Pricing:
        def fetch(self): return {"gpt-5.5": PublicModelPrice(Decimal("5"), Decimal("30"))}

    service = PlatformProviderService(Repo(), None, None, "http://relay/v1", Pricing())
    assert service.sync_public_prices("p1", force=True)["skipped_known"] == 1


def test_existing_provider_output_uses_current_configured_relay_url():
    service = PlatformProviderService(None, None, None, "https://relay.example/new/v1")
    row = ProviderRow("p1", "newapi", "LLM 网关", "http://127.0.0.1:9300/v1", "openai-completions", 1, "published", 2, datetime.now(UTC))
    assert service._provider_output(row).relay_base_url == "https://relay.example/new/v1"


def test_newapi_client_uses_server_management_identity_and_normalizes_models():
    seen = {}

    def handler(request: httpx.Request):
        seen["headers"] = request.headers
        seen["path"] = request.url.path
        return httpx.Response(200, json={"success": True, "data": {"models": "minimax-m3,minimax-m3, gpt-4o "}})

    client = NewApiAdminClient("http://newapi.test", "admin-pat", "1", transport=httpx.MockTransport(handler))
    assert client.get_channel_models(7) == ["gpt-4o", "minimax-m3"]
    assert client.fetch_channel_models(7) == ["gpt-4o", "minimax-m3"]
    assert seen["path"] == "/api/channel/7"
    assert seen["headers"]["authorization"] == "Bearer admin-pat"
    assert seen["headers"]["new-api-user"] == "1"


def test_newapi_client_rejects_missing_configured_models():
    client = NewApiAdminClient(
        "http://newapi.test", "admin-pat", "1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={"success": True, "data": {}})),
    )
    with pytest.raises(NewApiError, match="configured model list"):
        client.get_channel_models(7)


def test_newapi_relay_token_reuses_existing_deterministic_name_without_posting_again():
    calls: list[tuple[str, str]] = []

    def handler(request: httpx.Request):
        calls.append((request.method, request.url.path))
        if request.method == "GET":
            return httpx.Response(200, json={"success": True, "data": {"items": [{"id": 7, "name": "aiteam-tenant-v1"}]}})
        assert request.method == "POST" and request.url.path == "/api/token/7/key"
        return httpx.Response(200, json={"success": True, "data": {"key": "relay-key"}})

    client = NewApiAdminClient("http://newapi.test", "admin", "1", transport=httpx.MockTransport(handler))
    assert client.create_relay_token(dashboard_token="dashboard", user_id=2, name="aiteam-tenant-v1", model_ids=["m1"], remain_quota=10) == (7, "sk-relay-key")
    assert ("POST", "/api/token/") not in calls


def test_newapi_relay_token_polls_after_create_without_retrying_post():
    calls: list[tuple[str, str]] = []
    list_count = 0

    def handler(request: httpx.Request):
        nonlocal list_count
        calls.append((request.method, request.url.path))
        if request.method == "POST" and request.url.path == "/api/token/":
            return httpx.Response(200, json={"success": True})
        if request.method == "GET":
            list_count += 1
            items = [] if list_count < 3 else [{"id": 8, "name": "aiteam-tenant-v1"}]
            return httpx.Response(200, json={"success": True, "data": {"items": items}})
        return httpx.Response(200, json={"success": True, "data": {"key": "created-key"}})

    client = NewApiAdminClient("http://newapi.test", "admin", "1", transport=httpx.MockTransport(handler))
    assert client.create_relay_token(dashboard_token="dashboard", user_id=2, name="aiteam-tenant-v1", model_ids=["m1"], remain_quota=10) == (8, "sk-created-key")
    assert calls.count(("POST", "/api/token/")) == 1


def test_newapi_relay_token_fails_closed_on_preexisting_duplicate_names():
    def handler(request: httpx.Request):
        return httpx.Response(200, json={"success": True, "data": {"items": [{"id": 1, "name": "duplicate"}, {"id": 2, "name": "duplicate"}]}})

    client = NewApiAdminClient("http://newapi.test", "admin", "1", transport=httpx.MockTransport(handler))
    with pytest.raises(NewApiError, match=r"ambiguous.*1.*2"):
        client.create_relay_token(dashboard_token="dashboard", user_id=2, name="duplicate", model_ids=["m1"], remain_quota=10)


def test_platform_provider_service_maps_relay_token_ambiguity_to_conflict():
    now = datetime.now(UTC)
    provider = ProviderRow("p1", "internal-newapi", "LLM 网关", "http://relay/v1", "openai-completions", 1, "published", 1, now)
    model = ModelRow("p1", "minimax-m3", "MiniMax M3", {}, "published", "discovery", 1, now)
    rate = RateRow("r1", "p1", "minimax-m3", 1, "known", "token", Decimal("0.3"), Decimal("1.2"), None, None, None, "USD", "manual", None, now, None, True)
    access = AccessRow("a1", "tenant-1", "p1", b"token", b"management", ["minimax-m3"], "at-tenant", 7, 8, "expired", 1, None)

    class Repo:
        def get_provider(self, _provider_id): return provider
        def get_model(self, _provider_id, _model_id): return model
        def current_rate(self, _provider_id, _model_id): return rate
        def list_models(self, _provider_id, **_kwargs): return [model]
        def get_access(self, _tenant_id, _provider_id): return access

    class Crypto:
        def decrypt(self, value): return value.decode()

    class NewApi:
        def create_relay_token(self, **_kwargs): raise NewApiError("relay token name is ambiguous: aiteam-tenant (3, 4)")

    service = PlatformProviderService(Repo(), NewApi(), Crypto(), "http://relay/v1")
    with pytest.raises(Conflict, match="provisioning failed.*ambiguous"):
        service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["minimax-m3"])


def test_newapi_client_checks_business_failure_even_on_http_200():
    client = NewApiAdminClient(
        "http://newapi.test", "admin-pat", "1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={"success": False, "message": "denied"})),
    )
    with pytest.raises(NewApiError, match="denied"):
        client.get_channel_models(7)


def test_newapi_client_rejects_oversized_responses():
    client = NewApiAdminClient(
        "http://newapi.test", "admin-pat", "1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, content=json.dumps({"success": True, "data": "x" * (2 * 1024 * 1024)}))),
    )
    with pytest.raises(NewApiError, match="2 MiB"):
        client.pricing()
