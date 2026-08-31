from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from fastapi.testclient import TestClient

from manager_service.routes_platform_model import build_platform_model_router
from shared.app_factory import create_app
from shared.config import Settings
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def test_platform_model_route_accepts_model_and_rate_projection() -> None:
    from fastapi import APIRouter

    app = create_app(Settings(tier="manager", service_name="manager"), APIRouter())
    app.state._operator_catalog = type("Catalog", (), {
        "list_platform_catalog": lambda _self: {
            "providers": [{
                "provider_id": "p1", "provider_code": "newapi", "display_name": "LLM 网关",
                "relay_base_url": "https://relay.example/v1", "api_protocol": "openai-completions",
                "status": "published", "version": 1, "updated_at": datetime.now(UTC),
            }],
            "models": [{
                "model": {
                    "provider_id": "p1", "model_id": "minimax-m3", "display_name": "MiniMax M3",
                    "capabilities": {"reasoning": True, "thinking_levels": ["off", "high"]},
                    "status": "published", "source": "discovery", "version": 1,
                    "updated_at": datetime.now(UTC),
                },
                "rate": {
                    "rate_id": "r1", "provider_id": "p1", "model_id": "minimax-m3", "pricing_version": 1,
                    "pricing_status": "known", "billing_mode": "token", "input_usd_per_million": Decimal("0.3"),
                    "output_usd_per_million": Decimal("1.2"), "source": "public_reference",
                    "effective_from": datetime.now(UTC),
                },
            }],
        }
    })()
    app.include_router(build_platform_model_router(_VERIFIER))
    token = sign_inmem_token(_SIGNER, "tenant-a", ["owner"], user_id="owner-a")

    response = TestClient(app).get(
        "/api/manager/platform-models",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200, response.text
    model = response.json()["data"]["models"][0]
    assert model["model"]["model_id"] == "minimax-m3"
    assert model["rate"]["pricing_status"] == "known"
    assert model["model"]["capabilities"]["thinking_levels"] == ["off", "high"]
