from __future__ import annotations
from unittest.mock import Mock

from fastapi import APIRouter
from fastapi.testclient import TestClient

from manager_service.hindsight_client import HindsightSettings
from manager_service.hindsight_credentials import (
    HindsightLeaseStore,
    HindsightRuntimeService,
)
from manager_service.routes_hindsight import build_hindsight_router
from manager_service.schemas_hindsight import HindsightRuntimeConfigOut
from shared.app_factory import create_app
from shared.config import Settings
from shared.contracts.snapshot import EmployeeExecutionSnapshot
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token


class _Snapshot:
    def _ensure_runnable(self, ctx, *, employee_id: str):
        return None

    def generate(self, ctx, *, member_id: str, employee_id: str, employee_version=None):
        return EmployeeExecutionSnapshot(
            employee_id=employee_id,
            version="1",
            snapshot_version="snap-1",
            memory_policy={"enabled": True},
        )


def _client():
    verifier, signer = make_inmem_verifier_and_signer()
    app = create_app(
        Settings(tier="manager", service_name="m", db_url="postgresql://fake/fake"),
        APIRouter(),
    )
    service = HindsightRuntimeService(
        snapshot_service=_Snapshot(), bank_client=Mock(),
        settings=HindsightSettings(
            "https://hindsight.internal", "manager-only", None, None, None
        ),
        leases=HindsightLeaseStore(token_factory=lambda: "opaque-lease"),
    )
    app.state._hindsight_runtime_service = service
    app.include_router(build_hindsight_router(verifier))
    return TestClient(app), signer, service


def test_facade_fails_closed_without_manager_db_and_redacts_request_details():
    verifier, _signer = make_inmem_verifier_and_signer()
    app = create_app(
        Settings(tier="manager", service_name="m", db_url=None),
        APIRouter(),
    )
    app.include_router(build_hindsight_router(verifier))
    client = TestClient(app)
    secret = "opaque-lease-secret"
    response = client.post(
        "/api/manager/hindsight/v1/default/banks/bank-a/memories/recall/"
        + secret,
        headers={"Authorization": f"Bearer {secret}"},
        json={"query": "hello"},
    )
    assert response.status_code == 503
    assert secret not in response.text
    assert "hindsight.internal" not in response.text
    assert "/v1/default/banks" not in response.text


def test_runtime_config_route_has_no_store_and_revoke_never_returns_token():
    client, signer, service = _client()
    headers = {
        "Authorization": "Bearer "
        + sign_inmem_token(signer, "tenant-1", ["member"], user_id="member-1")
    }
    missing = client.post(
        "/api/manager/hindsight/runtime-config", json={"employee_id": "e1"}
    )
    assert missing.status_code == 401

    malformed = client.post(
        "/api/manager/hindsight/runtime-config",
        json={"employee_id": "e1", "bank_id": "other-bank"},
        headers=headers,
    )
    assert malformed.status_code == 422

    response = client.post(
        "/api/manager/hindsight/runtime-config",
        json={"employee_id": "e1"},
        headers=headers,
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    config = HindsightRuntimeConfigOut.model_validate(response.json()["data"])
    assert config.token == "opaque-lease"
    assert "manager-only" not in response.text

    revoke = client.post(
        f"/api/manager/hindsight/leases/{config.lease_id}/revoke", headers=headers
    )
    assert revoke.status_code == 200
    assert revoke.json()["data"]["status"] == "revoked"
    assert "token" not in revoke.json()["data"]
