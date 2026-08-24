from datetime import UTC, datetime
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from run import get_app
from shared.contracts.auth import TokenClaims
from shared.contracts.platform_provider import PlatformModel, PlatformModelRate, PlatformProvider


class FakePlatformProviders:
    def __init__(self):
        self.provider = PlatformProvider(
            provider_id="p1", provider_code="newapi", display_name="Internal NewAPI",
            relay_base_url="https://relay.example/v1", api_protocol="openai-completions",
            status="draft", version=1, updated_at=datetime.now(UTC),
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

    def create_provider(self, **_): return self.provider
    def list_providers(self, **_): return [self.provider]
    def sync_models(self, _provider_id): return [self.model]
    def publish_provider(self, _provider_id): return self.provider.model_copy(update={"status": "published", "version": 2})
    def list_models(self, _provider_id, **_): return [{"model": self.model, "rate": self.rate}]
    def set_rate(self, _provider_id, _model_id, **_): return self.rate
    def publish_model(self, _provider_id, _model_id): return self.model.model_copy(update={"status": "published", "version": 2})


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


def test_platform_provider_admin_flow_is_versioned_and_secret_free(client):
    created = client.post("/api/operation/providers", headers=auth(), json={
        "provider_code": "newapi", "display_name": "Internal NewAPI",
        "api_protocol": "openai-completions", "newapi_channel_id": 1,
    })
    assert created.status_code == 201
    assert "token" not in str(created.json()).lower()

    synced = client.post("/api/operation/providers/p1/sync-models", headers=auth())
    assert synced.status_code == 200
    assert synced.json()["data"][0]["model_id"] == "minimax-m3"

    rate = client.post("/api/operation/providers/p1/rates", headers=auth(), json={
        "model_id": "minimax-m3", "input_usd_per_million": "0.30",
        "output_usd_per_million": "1.20", "cache_read_usd_per_million": "0.06",
    })
    assert rate.status_code == 201
    assert rate.json()["data"]["input_usd_per_million"] == "0.300000"

    published = client.post("/api/operation/providers/p1/models/publish", headers=auth(), json={"model_id": "minimax-m3"})
    assert published.status_code == 200
    assert published.json()["data"]["status"] == "published"


def test_platform_provider_admin_routes_require_platform_auth(client):
    response = client.get("/api/operation/providers")
    assert response.status_code == 401
    assert response.headers["content-type"].startswith("application/problem+json")
