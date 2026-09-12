import json
from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest

from operation_service.newapi_client import NewApiAdminClient, NewApiError
from operation_service.platform_provider_repository import AccessRow, ModelRow, ProviderRow, RateRow
from operation_service.platform_provider_service import PlatformProviderService, _validated_relay_url, newapi_urls
from shared.errors import Conflict
from shared.contracts.platform_provider import PlatformModelRef
from operation_service.public_pricing_client import ModelsDevPricingClient, PublicModelPrice, PublicPricingError, _model_capabilities


def test_validated_relay_url_covers_production_dns_and_invalid_ports(monkeypatch):
    monkeypatch.setattr("operation_service.platform_provider_service.socket.getaddrinfo", lambda *_args, **_kwargs: [(2, 1, 6, "", ("93.184.216.34", 443))])
    monkeypatch.setenv("AITEAM_ENV", "production")
    assert _validated_relay_url("https://relay.example/v1/", name="NEWAPI_PUBLIC_BASE_URL", https_only=True, reject_local=True) == "https://relay.example/v1"
    with pytest.raises(ValueError, match="qualified public"):
        _validated_relay_url("https://newapi/v1", name="NEWAPI_PUBLIC_BASE_URL", https_only=True, reject_local=True)
    with pytest.raises(ValueError, match="invalid port"):
        _validated_relay_url("https://relay.example:bad/v1", name="NEWAPI_PUBLIC_BASE_URL", https_only=True, reject_local=True)


def test_newapi_url_is_configurable_like_other_manager_services(monkeypatch):
    monkeypatch.setenv("NEWAPI_URL", "https://relay.example/ai")
    monkeypatch.delenv("NEWAPI_ADMIN_BASE_URL", raising=False)
    monkeypatch.delenv("NEWAPI_PUBLIC_BASE_URL", raising=False)
    assert newapi_urls() == ("https://relay.example/ai", None)


@pytest.mark.parametrize("value", [
    "https://user:secret@relay.example/v1",
    "https://relay.example/v1?token=secret",
    "https://relay.example/v1#fragment",
    "https://relay.example/ v1",
    "https://relay.example/not-v1",
])
def test_newapi_urls_reject_unsafe_public_url(monkeypatch, value):
    monkeypatch.setenv("NEWAPI_URL", "https://newapi.example")
    monkeypatch.setenv("NEWAPI_PUBLIC_BASE_URL", value)
    with pytest.raises(ValueError, match="NEWAPI_PUBLIC_BASE_URL"):
        newapi_urls()


def test_newapi_urls_rejects_dns_private_public_url_in_production(monkeypatch):
    monkeypatch.setenv("NEWAPI_URL", "https://newapi.example")
    monkeypatch.setenv("NEWAPI_PUBLIC_BASE_URL", "https://relay.example/v1")
    monkeypatch.setattr("operation_service.platform_provider_service.socket.getaddrinfo", lambda *_args, **_kwargs: [(2, 1, 6, "", ("10.0.0.2", 443))])
    with pytest.raises(ValueError, match="global destinations"):
        newapi_urls(production=True)


def test_newapi_urls_rejects_local_public_url_in_production(monkeypatch):
    monkeypatch.setenv("NEWAPI_URL", "https://newapi.example")
    monkeypatch.setenv("NEWAPI_PUBLIC_BASE_URL", "https://127.0.0.2/v1")
    with pytest.raises(ValueError, match="local destination"):
        newapi_urls(production=True)


def test_newapi_urls_rejects_http_public_url_in_production(monkeypatch):
    monkeypatch.setenv("NEWAPI_URL", "https://newapi.example")
    monkeypatch.setenv("NEWAPI_PUBLIC_BASE_URL", "http://relay.example/v1")
    with pytest.raises(ValueError, match="HTTPS"):
        newapi_urls(production=True)


def test_public_relay_url_never_falls_back_to_private_newapi_url(monkeypatch):
    monkeypatch.setenv("NEWAPI_URL", "http://newapi:3000")
    monkeypatch.delenv("NEWAPI_ADMIN_BASE_URL", raising=False)
    monkeypatch.delenv("NEWAPI_PUBLIC_BASE_URL", raising=False)
    assert newapi_urls() == ("http://newapi:3000", None)


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
        def update_model_metadata(self, provider_id, model_id, **values):
            enriched.append((provider_id, model_id, values))
            return model
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
    provider = ProviderRow("p1", "newapi", "LLM 网关", "http://relay/v1", "openai-completions", 1, "published", 7, now)
    model = ModelRow(
        "p1", "minimax-m3", "MiniMax M3",
        {"reasoning": True, "thinking_levels": ["off", "high"]},
        "published", "discovery", 9, now,
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
    provider = ProviderRow("p1", "newapi", "LLM 网关", "http://relay/v1", "openai-completions", 1, "published", 7, now)
    mapping_model = ModelRow(
        "p1", "mapped", "Mapped", {"thinking_level_map": {"off": "none", "high": "high", "low": None}},
        "published", "discovery", 9, now,
    )
    plain_model = ModelRow(
        "p1", "plain", "Plain", {"reasoning": False}, "published", "discovery", 11, now,
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


def test_newapi_client_reads_full_key_from_verified_token_detail():
    paths = []

    def handler(request: httpx.Request):
        paths.append((request.method, request.url.path))
        if request.url.path == "/api/token/7":
            return httpx.Response(200, json={"success": True, "data": {
                "id": 7, "status": 1, "expired_time": -1,
                "model_limits_enabled": True, "model_limits": "m1", "key": "relay-key",
            }})
        return httpx.Response(200, json={"success": True, "data": {"items": [{"id": 7, "name": "relay"}]}})

    client = NewApiAdminClient("http://newapi.test", "admin", "1", transport=httpx.MockTransport(handler))
    assert client.create_relay_token(dashboard_token="dashboard", user_id=2, name="relay", model_ids=["m1"], remain_quota=10) == (7, "sk-relay-key")
    assert ("GET", "/api/token/7") in paths
    assert not any(path.endswith("/key") for _, path in paths)


def test_newapi_client_rejects_masked_verified_token_key():
    def handler(request: httpx.Request):
        if request.url.path == "/api/token/7":
            return httpx.Response(200, json={"success": True, "data": {
                "id": 7, "status": 1, "expired_time": -1,
                "model_limits_enabled": True, "model_limits": "m1", "key": "sk-********",
            }})
        return httpx.Response(200, json={"success": True, "data": {"items": [{"id": 7, "name": "relay"}]}})

    client = NewApiAdminClient("http://newapi.test", "admin", "1", transport=httpx.MockTransport(handler))
    with pytest.raises(NewApiError, match="full relay token key"):
        client.create_relay_token(dashboard_token="dashboard", user_id=2, name="relay", model_ids=["m1"], remain_quota=10)


def test_newapi_existing_name_requires_complete_detail_metadata():
    def handler(request: httpx.Request):
        if request.url.path == "/api/token/7":
            return httpx.Response(200, json={"success": True, "data": {"id": 7, "key": "full-key"}})
        return httpx.Response(200, json={"success": True, "data": {"items": [{"id": 7, "name": "relay"}]}})

    client = NewApiAdminClient("http://newapi.test", "admin", "1", transport=httpx.MockTransport(handler))
    with pytest.raises(NewApiError, match="invalid status"):
        client.create_relay_token(
            dashboard_token="dashboard", user_id=2, name="relay", model_ids=["m1"], remain_quota=10,
        )


def test_newapi_post_create_metadata_mismatch_carries_exact_id():
    def handler(request: httpx.Request):
        if request.method == "POST":
            return httpx.Response(200, json={"success": True})
        return httpx.Response(200, json={"success": True, "data": {"items": [{
            "id": 8, "name": "relay", "status": 2, "expired_time": -1,
            "model_limits_enabled": True, "model_limits": "m1",
        }]}})

    client = NewApiAdminClient("http://newapi.test", "admin", "1", transport=httpx.MockTransport(handler))
    with pytest.raises(NewApiError, match="not enabled") as exc_info:
        client.create_relay_token(
            dashboard_token="dashboard", user_id=2, name="relay", model_ids=["m1"], remain_quota=10,
        )
    assert exc_info.value.token_id == 8


def test_newapi_client_reads_recorded_token_beyond_first_page():
    def handler(request: httpx.Request):
        if request.url.params["p"] == "1":
            items = [{"id": i, "name": f"token-{i}"} for i in range(100)]
            return httpx.Response(200, json={"success": True, "data": {"items": items, "total": 101}})
        return httpx.Response(200, json={"success": True, "data": {"items": [{"id": 900, "name": "recorded"}], "total": 101}})

    client = NewApiAdminClient("http://newapi.test", "admin", "1", transport=httpx.MockTransport(handler))
    assert client.get_relay_token(dashboard_token="dashboard", user_id=2, token_id=900)["name"] == "recorded"


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
        if request.method == "GET" and request.url.path == "/api/token/7":
            return httpx.Response(200, json={"success": True, "data": {
                "id": 7, "status": 1, "expired_time": -1,
                "model_limits_enabled": True, "model_limits": "m1", "key": "relay-key",
            }})
        assert request.method == "GET" and request.url.path == "/api/token/"
        return httpx.Response(200, json={"success": True, "data": {"items": [{"id": 7, "name": "aiteam-tenant-v1"}]}})

    client = NewApiAdminClient("http://newapi.test", "admin", "1", transport=httpx.MockTransport(handler))
    assert client.create_relay_token(dashboard_token="dashboard", user_id=2, name="aiteam-tenant-v1", model_ids=["m1"], remain_quota=10) == (7, "sk-relay-key")
    assert ("POST", "/api/token/") not in calls


def test_newapi_reconcile_relay_token_never_posts_after_an_unknown_create():
    calls: list[tuple[str, str]] = []

    def handler(request: httpx.Request):
        calls.append((request.method, request.url.path))
        if request.method == "GET" and request.url.path == "/api/token/":
            return httpx.Response(200, json={"success": True, "data": {"items": [{
                "id": 7,
                "name": "relay",
                "status": 1,
                "expired_time": -1,
                "model_limits_enabled": True,
                "model_limits": "m1",
            }]}})
        if request.method == "GET" and request.url.path == "/api/token/7":
            return httpx.Response(200, json={"success": True, "data": {
                "id": 7,
                "status": 1,
                "expired_time": -1,
                "model_limits_enabled": True,
                "model_limits": "m1",
                "key": "relay-key",
            }})
        raise AssertionError((request.method, request.url.path))

    client = NewApiAdminClient("http://newapi.test", "admin", "1", transport=httpx.MockTransport(handler))
    assert client.reconcile_relay_token(
        dashboard_token="dashboard", user_id=2, name="relay", model_ids=["m1"], expired_time=-1,
    ) == (7, "sk-relay-key")
    assert ("POST", "/api/token/") not in calls


def test_newapi_find_user_reconciles_all_bounded_search_pages():
    pages: list[str] = []

    def handler(request: httpx.Request):
        pages.append(request.url.params["p"])
        if request.url.params["p"] == "1":
            items = [{"id": index, "username": f"other-{index}"} for index in range(20)]
            return httpx.Response(200, json={"success": True, "data": {"items": items, "total": 21}})
        return httpx.Response(200, json={"success": True, "data": {"items": [{"id": 11, "username": "target"}], "total": 21}})

    client = NewApiAdminClient("http://newapi.test", "admin", "1", transport=httpx.MockTransport(handler))
    assert client.find_user("target") == {"id": 11, "username": "target"}
    assert pages == ["1", "2"]


def test_newapi_relay_token_polls_after_create_without_retrying_post():
    calls: list[tuple[str, str]] = []
    list_count = 0

    def handler(request: httpx.Request):
        nonlocal list_count
        calls.append((request.method, request.url.path))
        if request.method == "POST" and request.url.path == "/api/token/":
            return httpx.Response(200, json={"success": True})
        if request.method == "GET" and request.url.path == "/api/token/":
            list_count += 1
            items = [] if list_count < 3 else [{
                "id": 8, "name": "aiteam-tenant-v1", "status": 1,
                "expired_time": -1, "model_limits_enabled": True, "model_limits": "m1",
            }]
            return httpx.Response(200, json={"success": True, "data": {"items": items}})
        if request.method == "GET" and request.url.path == "/api/token/8":
            return httpx.Response(200, json={"success": True, "data": {
                "id": 8, "status": 1, "expired_time": -1,
                "model_limits_enabled": True, "model_limits": "m1", "key": "created-key",
            }})
        raise AssertionError((request.method, request.url.path))

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


def test_newapi_lifecycle_update_preserves_upstream_quota_and_never_sends_key():
    requests = []

    def handler(request: httpx.Request):
        requests.append(request)
        if request.method == "GET" and request.url.path == "/api/token/9":
            return httpx.Response(200, json={"success": True, "data": {
                "id": 9, "name": "relay", "status": 1, "remain_quota": 321,
                "used_quota": 654, "expired_time": 100, "unlimited_quota": False,
                "model_limits_enabled": True, "model_limits": "m1", "allow_ips": "",
                "group": "default", "cross_group_retry": False,
            }})
        if request.method == "GET":
            return httpx.Response(200, json={"success": True, "data": {"items": [{
                "id": 9, "name": "relay", "status": 1, "remain_quota": 321,
                "used_quota": 654, "expired_time": 100, "model_limits_enabled": True,
                "model_limits": "m1", "allow_ips": "", "group": "default",
            }]}})
        return httpx.Response(200, json={"success": True, "data": {}})

    client = NewApiAdminClient("http://newapi.test", "admin", "1", transport=httpx.MockTransport(handler))
    client.update_relay_token(dashboard_token="dashboard", user_id=2, token_id=9, model_ids=["m2"], expired_time=200)

    payload = json.loads(requests[-1].content)
    assert requests[-1].method == "PUT"
    assert requests[-1].url.path == "/api/token/"
    assert payload["remain_quota"] == 321
    assert payload["model_limits"] == "m2"
    assert "key" not in payload
    assert "dashboard" not in requests[-1].content.decode()


def test_newapi_create_never_reuses_unrestricted_deterministic_token():
    client = NewApiAdminClient(
        "http://newapi.test", "admin", "1",
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=(
            {"success": True, "data": {"id": 9, "status": 1, "expired_time": 200,
                                      "model_limits_enabled": False, "model_limits": "", "key": "relay"}}
            if request.url.path == "/api/token/9"
            else {"success": True, "data": {"items": [{"id": 9, "name": "relay", "status": 1,
                                                         "expired_time": 200, "model_limits_enabled": False,
                                                         "model_limits": ""}]}}
        ))),
    )
    with pytest.raises(NewApiError, match="unrestricted model scope"):
        client.create_relay_token(
            dashboard_token="dashboard", user_id=2, name="relay", model_ids=["m1"], remain_quota=10,
            expired_time=200,
        )


def test_newapi_lifecycle_revoke_disable_and_delete_use_proven_routes():
    requests = []

    def handler(request: httpx.Request):
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(200, json={"success": True, "data": {"items": [{"id": 9, "name": "relay", "status": 1}]}})
        return httpx.Response(200, json={"success": True, "data": {}})

    client = NewApiAdminClient("http://newapi.test", "admin", "1", transport=httpx.MockTransport(handler))
    assert client.revoke_relay_token(dashboard_token="dashboard", user_id=2, token_id=9) is True
    assert client.delete_relay_token(dashboard_token="dashboard", user_id=2, token_id=9) is True

    assert requests[1].method == "PUT"
    assert requests[1].url.path == "/api/token/"
    assert requests[1].url.params["status_only"] == "true"
    assert json.loads(requests[1].content) == {"id": 9, "status": 2}
    assert requests[3].method == "DELETE"
    assert requests[3].url.path == "/api/token/9"


def test_newapi_client_rejects_invalid_search_quota_and_token_shapes(monkeypatch):
    client = NewApiAdminClient("http://newapi.test", "admin", "1")
    monkeypatch.setattr(client, "_request", lambda *_args, **_kwargs: {"success": True, "data": {"items": ["bad"]}})
    with pytest.raises(NewApiError, match="invalid user search"):
        client.find_user("target")
    monkeypatch.setattr(client, "_request", lambda *_args, **_kwargs: {"success": True, "data": {"items": [], "total": "bad"}})
    with pytest.raises(NewApiError, match="invalid user search total"):
        client.find_user("target")
    monkeypatch.setattr(client, "_request", lambda *_args, **_kwargs: {"success": True, "data": {"quota": -1}})
    with pytest.raises(NewApiError, match="invalid tenant quota"):
        client.get_user_quota(dashboard_token="dashboard", user_id=1)
    monkeypatch.setattr(client, "_request", lambda *_args, **_kwargs: {"success": True, "data": {"items": ["bad"]}})
    with pytest.raises(NewApiError, match="invalid token list"):
        client.list_relay_tokens(dashboard_token="dashboard", user_id=1)
    monkeypatch.setattr(client, "_request", lambda *_args, **_kwargs: {"success": True, "data": {"items": [], "total": "bad"}})
    with pytest.raises(NewApiError, match="invalid token list total"):
        client.list_relay_tokens(dashboard_token="dashboard", user_id=1)


def test_newapi_client_rejects_invalid_login_token_detail_and_keys(monkeypatch):
    client = NewApiAdminClient("http://newapi.test", "admin", "1")
    for response in ({"success": True, "data": {}}, {"success": True, "data": {"user": {"id": 1}, "access_token": ""}}):
        client._request = lambda *_args, response=response, **_kwargs: response
        with pytest.raises(NewApiError, match="invalid session"):
            client.login("u", "p")
    client._request = lambda *_args, **_kwargs: {"success": True, "data": {"id": 8}}
    with pytest.raises(NewApiError, match="mismatched relay token id"):
        client.get_relay_token_detail(dashboard_token="dashboard", user_id=1, token_id=7)
    client._request = lambda *_args, **_kwargs: {"success": True, "data": {"id": 7, "status": 1, "expired_time": -1, "model_limits_enabled": True, "model_limits": "m1", "key": "*masked"}}
    with pytest.raises(NewApiError, match="full relay token key"):
        client.get_relay_token_key(dashboard_token="dashboard", user_id=1, token_id=7)
    client._request = lambda *_args, **_kwargs: {"success": True, "data": {"id": 7, "status": 1, "expired_time": -1, "model_limits_enabled": True, "model_limits": "m1", "key": "full"}}
    assert client.get_relay_token_key(dashboard_token="dashboard", user_id=1, token_id=7) == "sk-full"


def test_newapi_client_reconciles_missing_disabled_and_delete_states(monkeypatch):
    client = NewApiAdminClient("http://newapi.test", "admin", "1")
    monkeypatch.setattr(client, "get_relay_token", lambda **_kwargs: None)
    assert client.revoke_relay_token(dashboard_token="d", user_id=1, token_id=9) is False
    assert client.delete_relay_token(dashboard_token="d", user_id=1, token_id=9) is False
    monkeypatch.setattr(client, "get_relay_token", lambda **_kwargs: {"id": 9, "status": 2})
    assert client.revoke_relay_token(dashboard_token="d", user_id=1, token_id=9) is False
    monkeypatch.setattr(client, "_request", lambda *_args, **_kwargs: (_ for _ in ()).throw(NewApiError("HTTP 404")))
    with pytest.raises(NewApiError, match="HTTP 404"):
        client.delete_relay_token(dashboard_token="d", user_id=1, token_id=9)
    assert client.delete_relay_token(dashboard_token="d", user_id=1, token_id=9, missing_ok=True) is False


def test_newapi_client_static_metadata_helpers_cover_all_formats():
    client = NewApiAdminClient("http://newapi.test", "admin", "1")
    assert client._model_limits("m1,m2") == "m1,m2"
    assert client._model_limits(["m1", "", 2]) == "m1,2"
    assert client._model_limits({"m1": True, "m2": False}) == "m1"
    assert client._model_limits(None) == ""
    assert client._token_id({"id": "7"}) == 7
    assert client._token_id({"id": "bad"}) is None
    assert client._matching_token([], "x") is None
    with pytest.raises(NewApiError, match="ambiguous"):
        client._matching_token([{"id": 2, "name": "x"}, {"id": 1, "name": "x"}], "x")
    assert client._has_complete_token_metadata({"status": 1, "expired_time": -1, "model_limits_enabled": True, "model_limits": "m"})
    assert not client._has_complete_token_metadata({"status": 1})
    with pytest.raises(NewApiError, match="invalid status"):
        client._validate_token_metadata({}, model_ids=["m"], expired_time=-1)
    with pytest.raises(NewApiError, match="no model scope"):
        client._validate_token_metadata({"status": 1, "model_limits_enabled": True, "model_limits": None, "expired_time": -1}, model_ids=["m"], expired_time=-1)
    with pytest.raises(NewApiError, match="scope does not match"):
        client._validate_token_metadata({"status": 1, "model_limits_enabled": True, "model_limits": "m2", "expired_time": -1}, model_ids=["m"], expired_time=-1)
    with pytest.raises(NewApiError, match="expiry"):
        client._validate_token_metadata({"status": 1, "model_limits_enabled": True, "model_limits": "m", "expired_time": -1}, model_ids=["m"], expired_time=100)


def test_newapi_lifecycle_transport_failure_is_unknown_not_replayed():
    calls = []

    def handler(request: httpx.Request):
        calls.append(request.method)
        raise httpx.ReadTimeout("simulated")

    client = NewApiAdminClient("http://newapi.test", "admin", "1", transport=httpx.MockTransport(handler))
    with pytest.raises(NewApiError, match="outcome is unknown"):
        client.delete_relay_token(dashboard_token="dashboard", user_id=2, token_id=9)
    # Reconciliation fails before DELETE, so the uncertain operation is never
    # blindly replayed.
    assert calls == ["GET"]
