from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

from fastapi import APIRouter
from fastapi.testclient import TestClient

from manager_service.routes_provider import build_provider_credential_router
from manager_service.schemas_provider import RuntimeProviderConfigOut
from shared.app_factory import create_app
from shared.config import Settings
from shared.contracts.platform_provider import PricingSnapshot
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def client(fake):
    app = create_app(Settings(tier="manager", service_name="manager", db_url="postgresql://fake"), APIRouter())
    app.state._token_verifier = _VERIFIER
    app.include_router(build_provider_credential_router(_VERIFIER))
    return TestClient(app), fake


def auth():
    return {"Authorization": "Bearer " + sign_inmem_token(_SIGNER, "t1", ["member"])}


def runtime_out():
    return RuntimeProviderConfigOut(
        base_url="https://relay.example/v1", api_protocol="openai-completions",
        api_key="tenant-token", model="minimax-m3", provider_ref="provider-1",
        provider_version=2, model_version=3,
        pricing=PricingSnapshot(
            pricing_version=4, pricing_status="known", input_usd_per_million="0.30",
            output_usd_per_million="1.20", effective_from=datetime.now(UTC),
        ),
        version=5,
    )


def test_runtime_config_is_protected_and_is_no_store():
    fake = MagicMock(); fake.runtime_config.return_value = runtime_out()
    c, _ = client(fake)
    with patch("manager_service.routes_provider._service", return_value=fake):
        response = c.post("/api/manager/provider-credentials/runtime-config", headers=auth(), json={"employee_id": "e1"})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["data"]["pricing"]["pricing_version"] == 4
    assert response.json()["data"]["api_key"] == "tenant-token"
    assert c.get("/api/manager/provider-credentials", headers=auth()).status_code == 404
    assert c.post("/api/manager/provider-credentials", headers=auth(), json={}).status_code == 404


def test_speech_runtime_config_is_member_scoped_and_does_not_require_employee():
    fake = MagicMock(); fake.speech_runtime_config.return_value = runtime_out()
    c, _ = client(fake)
    with patch("manager_service.routes_provider._service", return_value=fake):
        response = c.post("/api/manager/provider-credentials/speech/runtime-config", headers=auth(), json={})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["data"]["model"] == "minimax-m3"
    fake.speech_runtime_config.assert_called_once()


def test_runtime_config_requires_authentication():
    fake = MagicMock(); fake.runtime_config.return_value = runtime_out()
    c, _ = client(fake)
    response = c.post("/api/manager/provider-credentials/runtime-config", json={"employee_id": "e1"})
    assert response.status_code == 401
