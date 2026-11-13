"""R9: POST /api/auth/password route."""
from __future__ import annotations
from unittest.mock import MagicMock
import pytest
from fastapi.testclient import TestClient
from shared.config import Settings
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token

_V, _S = make_inmem_verifier_and_signer()
T = "00000000-0000-4000-8000-000000000001"


def _client(svc):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service import routes_auth

    app = create_app(Settings(tier="manager", service_name="m", db_url="postgresql://fake/x", admin_db_url="postgresql://fake/y"), manager_router)
    app.state._token_verifier = _V
    app.state._auth_service = svc
    app.include_router(routes_auth.router)
    return TestClient(app)


def _h():
    return {"Authorization": f"Bearer {sign_inmem_token(_S, T, ['member'])}"}


def test_requires_token():
    assert _client(MagicMock()).post("/api/auth/password", json={"old_password": "a", "new_password": "b"}).status_code == 401


def test_success_calls_service_with_claims():
    svc = MagicMock()
    r = _client(svc).post("/api/auth/password", json={"old_password": "a", "new_password": "b"}, headers=_h())
    assert r.status_code == 200 and r.json()["data"] == {"changed": True}
    claims = svc.change_password.call_args.args[0]
    assert claims.tenant_id == T
    assert svc.change_password.call_args.kwargs == {"old_password": "a", "new_password": "b"}


def test_extra_field_rejected():
    r = _client(MagicMock()).post("/api/auth/password", json={"old_password": "a", "new_password": "b", "x": 1}, headers=_h())
    assert r.status_code == 422
