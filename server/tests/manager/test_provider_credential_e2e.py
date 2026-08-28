"""Manager Provider route contract (integration, D18/D22).

Provider/model/rate/access truth belongs to Operator. Manager exposes only the
employee-scoped ``runtime-config`` projection; the historical Provider CRUD
routes must remain absent.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from tests.manager._auth_helper import (
    make_inmem_verifier_and_signer,
    make_verifier,
    sign_inmem_token,
    sign_token,
)

pytestmark = pytest.mark.integration

_INMEM_VERIFIER, _INMEM_SIGNER = make_inmem_verifier_and_signer()


def _client(db_url: str | None, admin_url: str | None = None) -> TestClient:
    from manager_service.app import router as manager_router
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.routes_provider import build_provider_credential_router
    from shared.app_factory import create_app

    verifier = make_verifier(admin_url) if admin_url else _INMEM_VERIFIER
    settings = Settings(tier="manager", service_name="aiteam-manager-service", db_url=db_url)
    app = create_app(settings, manager_router)
    app.include_router(auth_router)
    app.include_router(build_employee_router(verifier))
    app.include_router(build_provider_credential_router(verifier))
    return TestClient(app)


def _token(
    tenant_id: str,
    roles: list[str],
    user_id: str | None = None,
    *,
    admin_url: str | None = None,
) -> str:
    uid = user_id or str(uuid.uuid4())
    if admin_url:
        return sign_token(admin_url, tenant_id, roles, user_id=uid)
    return sign_inmem_token(_INMEM_SIGNER, tenant_id, roles, user_id=uid)


def test_provider_crud_is_removed_and_runtime_route_stays_protected(
    migrated_db, admin_url, two_tenants
):
    tid, _ = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    token = _token(tid, ["owner"], user_id="owner", admin_url=admin_url)
    headers = {"Authorization": f"Bearer {token}"}

    # D18: Manager no longer owns Provider CRUD or secrets.
    response = client.post(
        "/api/manager/provider-credentials",
        json={"provider_ref": "relay-default", "secret": "must-not-be-accepted"},
        headers=headers,
    )
    assert response.status_code == 404
    assert client.get("/api/manager/provider-credentials", headers=headers).status_code == 404

    # The remaining route is employee-scoped and still enforces auth/business
    # lookup; an unknown employee is not a successful runtime projection.
    response = client.post(
        "/api/manager/provider-credentials/runtime-config",
        json={"employee_id": str(uuid.uuid4())},
        headers=headers,
    )
    assert response.status_code == 404


def test_manager_provider_runtime_route_without_db_is_fail_closed():
    client = _client(db_url=None)
    path = "/api/manager/provider-credentials/runtime-config"

    response = client.post(path, json={"employee_id": "e1"})
    assert response.status_code == 401
    assert response.headers["content-type"].startswith("application/problem+json")

    token = _token("t1", ["owner"])
    response = client.post(path, json={"employee_id": "e1"}, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 503
    assert response.json()["code"] == "manager_db_unconfigured"
