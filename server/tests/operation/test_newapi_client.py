import json
from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest

from operation_service.newapi_client import NewApiAdminClient, NewApiError
from operation_service.platform_provider_repository import ModelRow, ProviderRow
from operation_service.platform_provider_service import PlatformProviderService, newapi_urls
from operation_service.public_pricing_client import ModelsDevPricingClient, PublicModelPrice


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
        "minimax": {"models": {"MiniMax-M3": {"id": "MiniMax-M3", "cost": {"input": 0.3, "output": 1.2}}}},
        "free": {"models": {"free-model": {"id": "free-model", "cost": {"input": 0, "output": 0}}}},
    }
    client = ModelsDevPricingClient("https://models.dev/api.json", transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=payload)))
    prices = client.fetch()
    assert prices["gpt-5.5"].input_usd_per_million == 5
    assert prices["minimax-m3"].output_usd_per_million == Decimal("1.2")
    assert "free-model" not in prices


def test_public_price_sync_only_fills_unpriced_models():
    provider = ProviderRow("p1", "newapi", "NewAPI", "http://old/v1", "openai-completions", 1, "draft", 1, datetime.now(UTC))
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


def test_existing_provider_output_uses_current_configured_relay_url():
    service = PlatformProviderService(None, None, None, "https://relay.example/new/v1")
    row = ProviderRow("p1", "newapi", "NewAPI", "http://127.0.0.1:9300/v1", "openai-completions", 1, "published", 2, datetime.now(UTC))
    assert service._provider_output(row).relay_base_url == "https://relay.example/new/v1"


def test_newapi_client_uses_server_management_identity_and_normalizes_models():
    seen = {}

    def handler(request: httpx.Request):
        seen["headers"] = request.headers
        seen["path"] = request.url.path
        return httpx.Response(200, json={"success": True, "data": ["minimax-m3", "minimax-m3", " gpt-4o "]})

    client = NewApiAdminClient("http://newapi.test", "admin-pat", "1", transport=httpx.MockTransport(handler))
    assert client.fetch_channel_models(7) == ["gpt-4o", "minimax-m3"]
    assert seen["path"] == "/api/channel/fetch_models/7"
    assert seen["headers"]["authorization"] == "Bearer admin-pat"
    assert seen["headers"]["new-api-user"] == "1"


def test_newapi_client_checks_business_failure_even_on_http_200():
    client = NewApiAdminClient(
        "http://newapi.test", "admin-pat", "1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={"success": False, "message": "denied"})),
    )
    with pytest.raises(NewApiError, match="denied"):
        client.fetch_channel_models(7)


def test_newapi_client_rejects_oversized_responses():
    client = NewApiAdminClient(
        "http://newapi.test", "admin-pat", "1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, content=json.dumps({"success": True, "data": "x" * (2 * 1024 * 1024)}))),
    )
    with pytest.raises(NewApiError, match="2 MiB"):
        client.pricing()
