"""Loop A Stage A: F01/F02 HTTP writes stay fail-closed behind the phase gate."""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient


def _manager_client(tenant_id: str) -> TestClient:
    from manager_service.app import app as manager_app
    from tests.integration.fixtures.manager_binding import bind_manager_app

    bind_manager_app(tenant_id, manager_app)
    return TestClient(manager_app)


def _assert_phase_pending(resp):
    assert resp.status_code == 503, resp.text
    assert resp.headers.get("content-type", "").startswith("application/problem+json")
    assert resp.json()["code"] == "multitenancy_phase_pending"


@pytest.mark.integration
@pytest.mark.pr_quick
def test_tenant_provision_creates_tenant_registry(
    tenant_scope, service_token_headers, migrated_pg, fresh_tenant_cleanup,
):
    new_tenant_id = fresh_tenant_cleanup(str(uuid.uuid4()))
    client = _manager_client(new_tenant_id)
    resp = client.post(
        "/api/manager/tenants",
        json={
            "enterprise_id": str(uuid.uuid4()),
            "tenant_id": new_tenant_id,
            "enterprise_name": "Test Corp",
            "enterprise_code": f"ent_{uuid.uuid4().hex[:8]}",
        },
        headers=service_token_headers,
    )
    _assert_phase_pending(resp)


@pytest.mark.integration
def test_tenant_provision_has_envelope_and_problem_json_headers(
    tenant_scope, service_token_headers, fresh_tenant_cleanup,
):
    new_tenant_id = fresh_tenant_cleanup(str(uuid.uuid4()))
    client = _manager_client(new_tenant_id)
    resp = client.post(
        "/api/manager/tenants",
        json={
            "enterprise_id": str(uuid.uuid4()),
            "tenant_id": new_tenant_id,
            "enterprise_name": "EnvCorp",
            "enterprise_code": f"env_{uuid.uuid4().hex[:6]}",
        },
        headers=service_token_headers,
    )
    _assert_phase_pending(resp)
    assert "text/html" not in resp.headers.get("content-type", "")


@pytest.mark.integration
def test_tenant_provision_with_quota_policy(
    tenant_scope, service_token_headers, fresh_tenant_cleanup,
):
    new_tenant_id = fresh_tenant_cleanup(str(uuid.uuid4()))
    client = _manager_client(new_tenant_id)
    resp = client.post(
        "/api/manager/tenants",
        json={
            "enterprise_id": str(uuid.uuid4()),
            "tenant_id": new_tenant_id,
            "enterprise_name": "QuotaCorp",
            "enterprise_code": f"qt_{uuid.uuid4().hex[:6]}",
            "initial_quota_policy": {
                "policy_slug": "basic",
                "display_name": "Basic Plan",
                "scope": "tenant",
                "window_days": 30,
                "dimensions": {"cost_cap_usd": 50, "token_cap": 100000},
                "enforcement": "soft",
            },
        },
        headers=service_token_headers,
    )
    _assert_phase_pending(resp)


@pytest.mark.integration
@pytest.mark.pr_quick
def test_owner_bootstrap_creates_identity(
    tenant_scope, service_token_headers, fresh_tenant_cleanup,
):
    new_tenant_id = fresh_tenant_cleanup(str(uuid.uuid4()))
    client = _manager_client(new_tenant_id)
    r2 = client.post(
        "/api/manager/owner-bootstrap",
        json={
            "tenant_id": new_tenant_id,
            "owner_phone": f"1{uuid.uuid4().int % 10_000_000_000:010d}",
            "bootstrap_secret": f"Bs!1-{uuid.uuid4().hex[:12]}",
            "must_reset": True,
        },
        headers=service_token_headers,
    )
    _assert_phase_pending(r2)


@pytest.mark.integration
def test_owner_bootstrap_idempotent(
    tenant_scope, service_token_headers, fresh_tenant_cleanup,
):
    new_tenant_id = fresh_tenant_cleanup(str(uuid.uuid4()))
    client = _manager_client(new_tenant_id)
    body = {
        "tenant_id": new_tenant_id,
        "owner_phone": f"1{uuid.uuid4().int % 10_000_000_000:010d}",
        "bootstrap_secret": f"Bs!1-{uuid.uuid4().hex[:12]}",
        "must_reset": True,
    }
    _assert_phase_pending(client.post("/api/manager/owner-bootstrap", json=body, headers=service_token_headers))
    _assert_phase_pending(client.post("/api/manager/owner-bootstrap", json=body, headers=service_token_headers))


@pytest.mark.integration
def test_full_provision_chain_owner_whoami_returns_correct_tenant(
    tenant_scope, service_token_headers, fresh_tenant_cleanup,
):
    import os as _os
    admin_url = _os.getenv("ADMIN_DB_URL")
    db_url = _os.getenv("DB_URL")
    if not admin_url or not db_url:
        pytest.skip("ADMIN_DB_URL 和 DB_URL 均需配置")

    import psycopg
    from manager_service.auth_service import LoginInput, OwnerResetInput, build_auth_service
    from shared.errors import Forbidden

    new_tenant_id = fresh_tenant_cleanup(str(uuid.uuid4()))
    client = _manager_client(new_tenant_id)
    slug = f"fc_{uuid.uuid4().hex[:6]}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO tenant_registry (tenant_id, enterprise_slug, enterprise_code) VALUES (%s, %s, %s)",
            (new_tenant_id, slug, slug),
        )
    phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    bootstrap_pw = f"Boot!1-{uuid.uuid4().hex[:8]}"
    service = build_auth_service(db_url, admin_dsn=admin_url)
    service.provision_owner(new_tenant_id, phone=phone, bootstrap_password=bootstrap_pw)
    with pytest.raises(Forbidden):
        service.login(LoginInput(tenant_id=new_tenant_id, account=phone, password=bootstrap_pw))
    new_pw = f"New!1-{uuid.uuid4().hex[:8]}"
    result = service.owner_reset(
        OwnerResetInput(tenant_id=new_tenant_id, account=phone, old_password=bootstrap_pw, new_password=new_pw)
    )
    whoami_resp = client.get("/api/manager/whoami", headers={"Authorization": f"Bearer {result.token}"})
    assert whoami_resp.status_code == 200, whoami_resp.text
    assert whoami_resp.json()["data"]["tenant_id"] == new_tenant_id


@pytest.mark.integration
def test_tenant_provision_missing_fields_422(tenant_scope, service_token_headers):
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    resp = client.post(
        "/api/manager/tenants",
        json={"tenant_id": "t-no-ent-id"},
        headers=service_token_headers,
    )
    assert resp.status_code == 422
    assert resp.headers.get("content-type", "").startswith("application/problem+json")
    assert resp.json()["code"] == "validation_error"


@pytest.mark.integration
def test_owner_bootstrap_missing_fields_422(tenant_scope, service_token_headers):
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    resp = client.post(
        "/api/manager/owner-bootstrap",
        json={"tenant_id": "t1"},
        headers=service_token_headers,
    )
    assert resp.status_code == 422
    assert resp.headers.get("content-type", "").startswith("application/problem+json")
