"""Connector ops route branch tests (B05, issue #296).

Non-PG (no DB): uses the inmem RS256 verifier/signer and patches the DB-backed
service factory in routes_connector_ops with an in-memory fake so the HTTP layer
can be exercised without touching PostgreSQL.
"""

from __future__ import annotations

from datetime import datetime
from unittest.mock import patch

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from shared.app_factory import create_app
from shared.config import Settings
from shared.contracts.auth import TokenClaims
from tests.manager._auth_helper import make_inmem_verifier_and_signer


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _sign(roles):
    return _SIGNER.sign(TokenClaims(
        tenant_id="11111111-1111-1111-1111-111111111111",
        user_id="u-1", roles=list(roles), exp=9999999999,
    ))


class _FakeConnectorService:
    def __init__(self):
        self.calls: list[tuple] = []

    def get_status(self, ctx, connector_id):
        self.calls.append(("get_status", connector_id))
        return {"connector_id": connector_id, "status": "connected",
                "last_check_at": datetime.utcnow(), "error_message": None}

    def test_connector(self, ctx, connector_id, **kwargs):
        self.calls.append(("test_connector", connector_id, kwargs))
        return {"connector_id": connector_id, "success": True, "latency_ms": 1,
                "message": "ok", "auth_scheme": "oauth2", "flow": "authorization_code"}

    def get_grants(self, ctx, connector_id):
        self.calls.append(("get_grants", connector_id))
        return {"connector_id": connector_id, "employee_ids": ["emp-a"]}

    def set_grants(self, ctx, connector_id, employee_ids, action):
        self.calls.append(("set_grants", connector_id, employee_ids, action))
        return {"connector_id": connector_id, "employee_ids": employee_ids,
                "action": action, "updated": True}


@pytest.fixture()
def client():
    from manager_service.routes_capability import build_capability_router
    from manager_service.routes_connector_ops import build_connector_ops_router

    app = create_app(Settings(tier="manager", service_name="m", db_url="postgres://x/y"),
                     APIRouter())
    app.include_router(build_connector_ops_router(_VERIFIER))
    # The capability router has /connectors/{catalog_id}; ops must remain first.
    app.include_router(build_capability_router(_VERIFIER))
    fake = _FakeConnectorService()

    def _fake_service(request):
        return fake

    with patch("manager_service.routes_connector_ops._service", _fake_service):
        tc = TestClient(app)
        tc.fake = fake
        yield tc


_AUTH = {"Authorization": "Bearer " + _sign(["owner"])}


def test_list_presets_requires_auth(client):
    r = client.get("/api/manager/connectors/presets")
    assert r.status_code == 401


def test_get_status_requires_auth(client):
    r = client.get("/api/manager/connectors/slack/status")
    assert r.status_code == 401


def test_test_connector_requires_auth(client):
    r = client.post("/api/manager/connectors/slack/test", json={"auth_scheme": "oauth2"})
    assert r.status_code == 401


def test_list_presets_returns_known_presets(client):
    r = client.get("/api/manager/connectors/presets", headers=_AUTH)
    assert r.status_code == 200
    ids = {p["preset_id"] for p in r.json()["data"]}
    assert {"feishu", "jira", "slack", "github", "dingtalk"} <= ids


def test_get_status_returns_envelope(client):
    r = client.get("/api/manager/connectors/slack/status", headers=_AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["data"]["connector_id"] == "slack"
    assert body["data"]["status"] == "connected"


def test_test_connector_accepts_body_and_returns_result(client):
    r = client.post("/api/manager/connectors/feishu/test",
                    json={"auth_scheme": "oauth2",
                          "config_schema_json": {"properties": {"app_id": {"type": "string"}}}},
                    headers=_AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["data"]["connector_id"] == "feishu"
    assert body["data"]["auth_scheme"] == "oauth2"
    assert body["data"]["flow"] == "authorization_code"
    # Body forwarded to service layer.
    svc_calls = [c for c in client.fake.calls if c[0] == "test_connector"]
    assert svc_calls, "service.test_connector should have been called"
    _, _, kwargs = svc_calls[0]
    assert kwargs["auth_scheme"] == "oauth2"
    assert kwargs["config_schema_json"] == {"properties": {"app_id": {"type": "string"}}}


def test_test_connector_accepts_empty_body(client):
    r = client.post("/api/manager/connectors/feishu/test", json={}, headers=_AUTH)
    assert r.status_code == 200
    call = [item for item in client.fake.calls if item[0] == "test_connector"][-1]
    assert call[2]["auth_scheme"] == "oauth2"


def test_patch_grants_defaults_when_body_empty(client):
    r = client.patch("/api/manager/connectors/slack/grants", json={}, headers=_AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["data"]["action"] == "grant"
    assert body["data"]["employee_ids"] == []


def test_patch_grants_revoke(client):
    r = client.patch("/api/manager/connectors/slack/grants",
                     json={"employee_ids": ["emp-a"], "action": "revoke"},
                     headers=_AUTH)
    assert r.status_code == 200
    assert r.json()["data"]["action"] == "revoke"
