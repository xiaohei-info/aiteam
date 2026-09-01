from datetime import UTC, datetime
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from operation_service import routes_platform_provider
from run import get_app
from shared.contracts.auth import TokenClaims
from shared.contracts.platform_provider import PlatformModel, PlatformModelRate, PlatformProvider


class FakePlatformProviders:
    def __init__(self):
        self.provider = PlatformProvider(
            provider_id="p1", provider_code="newapi", display_name="LLM 网关",
            relay_base_url="https://relay.example/v1", api_protocol="openai-completions",
            status="published", version=1, updated_at=datetime.now(UTC),
        )
        self.model = PlatformModel(
            provider_id="p1", model_id="minimax-m3", display_name="MiniMax M3",
            status="draft", version=1, updated_at=datetime.now(UTC),
        )
        self.rate = PlatformModelRate(
            rate_id="r1", provider_id="p1", model_id="minimax-m3", pricing_version=1,
            pricing_status="known", input_usd_per_million=Decimal("0.300000"),
            output_usd_per_million=Decimal("1.200000"), cache_read_usd_per_million=Decimal("0.060000"),
            source="manual", effective_from=datetime.now(UTC), manually_overridden=True,
        )

    def list_providers(self, **_): return [self.provider]
    def sync_models(self, _provider_id): return [self.model]
    def list_models(self, _provider_id, **_): return [{"model": self.model, "rate": self.rate}]
    def set_rate(self, _provider_id, _model_id, **_): return self.rate
    def sync_public_prices(self, _provider_id, **_): return {"source": "models.dev", "updated": 1, "skipped_known": 0, "skipped_manual": 0, "unmatched": 0}
    def publish_model(self, _provider_id, _model_id): return self.model.model_copy(update={"status": "published", "version": 2})
    def publish_priced_models(self, _provider_id): return {"published": 26}


@pytest.fixture
def client():
    app = get_app("operation")
    app.state._platform_provider_service = FakePlatformProviders()
    yield TestClient(app)
    del app.state._platform_provider_service


def auth() -> dict[str, str]:
    from operation_service.app import _auth
    token = _auth.signer.sign(TokenClaims(user_id="op1", roles=["system_admin"], exp=9999999999))
    return {"Authorization": f"Bearer {token}"}


def test_service_catalog_preserves_model_and_rate_shape(client):
    response = client.get(
        "/api/operation/catalog/platform-providers",
        headers={"X-Service-Token": "test-service-token"},
    )
    assert response.status_code == 200, response.text
    item = response.json()["data"]["models"][0]
    assert item["model"]["model_id"] == "minimax-m3"
    assert item["rate"]["pricing_status"] == "known"


def test_service_catalog_supports_legacy_service_signature(client):
    class LegacyPlatformProviders(FakePlatformProviders):
        def list_platform_catalog(self):
            return {
                "providers": [self.provider],
                "models": [{"model": self.model, "rate": self.rate}],
            }

    client.app.state._platform_provider_service = LegacyPlatformProviders()
    response = client.get(
        "/api/operation/catalog/platform-providers?tenant_id=tenant-1",
        headers={"X-Service-Token": "test-service-token"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["data"]["models"][0]["model"]["model_id"] == "minimax-m3"


def test_platform_provider_admin_flow_is_versioned_and_secret_free(client):
    listed = client.get("/api/operation/providers", headers=auth())
    assert listed.status_code == 200
    assert listed.json()["data"][0]["provider_code"] == "newapi"
    assert "token" not in str(listed.json()).lower()

    model_list = client.get("/api/operation/providers/p1/models", headers=auth())
    assert model_list.status_code == 200
    assert model_list.json()["data"]["items"][0]["model"]["model_id"] == "minimax-m3"
    assert model_list.json()["data"]["items"][0]["rate"]["input_usd_per_million"] == "0.300000"

    synced = client.post("/api/operation/providers/p1/sync-models", headers=auth())
    assert synced.status_code == 200
    assert synced.json()["data"][0]["model_id"] == "minimax-m3"

    public_prices = client.post("/api/operation/providers/p1/sync-public-prices", headers=auth())
    assert public_prices.status_code == 200
    assert public_prices.json()["data"]["source"] == "models.dev"

    rate = client.post("/api/operation/providers/p1/rates", headers=auth(), json={
        "model_id": "minimax-m3", "input_usd_per_million": "0.30",
        "output_usd_per_million": "1.20", "cache_read_usd_per_million": "0.06",
    })
    assert rate.status_code == 201
    assert rate.json()["data"]["input_usd_per_million"] == "0.300000"

    published = client.post("/api/operation/providers/p1/models/publish", headers=auth(), json={"model_id": "minimax-m3"})
    assert published.status_code == 200
    assert published.json()["data"]["status"] == "published"

    published_priced = client.post("/api/operation/providers/p1/models/publish-priced", headers=auth())
    assert published_priced.status_code == 200
    assert published_priced.json()["data"]["published"] == 26


def test_provider_configuration_error_uses_llm_gateway_label(monkeypatch):
    app = get_app("operation")
    app.state._platform_provider_service = None
    monkeypatch.setattr(routes_platform_provider, "build_platform_provider_service", lambda: (_ for _ in ()).throw(RuntimeError("missing configuration")))
    request = Request({"type": "http", "app": app})

    with pytest.raises(routes_platform_provider._ProviderNotConfigured, match="Operator LLM gateway settings are incomplete"):
        routes_platform_provider._service(request)


def test_provider_creation_route_is_not_available(client):
    response = client.post("/api/operation/providers", headers=auth(), json={})
    assert response.status_code == 405


def test_platform_provider_admin_routes_require_platform_auth(client):
    response = client.get("/api/operation/providers")
    assert response.status_code == 401
    assert response.headers["content-type"].startswith("application/problem+json")
