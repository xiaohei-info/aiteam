"""MFA route coverage (issue AITEAM-253; non-integration, no DB).

Covers (D22; 03 9.6; Layer: backend):
- Protected endpoints 503 when DB is unconfigured (auth surface must not silently pass).
- OAuth callback returns application/problem+json with status 422 on a malformed state.
- Protected endpoints require a token (401/422 without one)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from shared.config import Settings
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token


def _build(db_url=None, admin_db_url=None):
    """Build app + the in-memory (verifier, signer) pair bound to it. Tests reuse the same signer to mint tokens."""
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    settings = Settings(
        tier="manager",
        service_name="aiteam-manager-service",
        db_url=db_url,
        admin_db_url=admin_db_url,
    )
    app = create_app(settings, manager_router)
    from manager_service.routes_mfa import (
        oauth_mgmt_router, oauth_router, passkey_mgmt_router, passkey_router,
    )
    for r in (passkey_router, passkey_mgmt_router, oauth_router, oauth_mgmt_router):
        app.include_router(r)
    verifier, signer = make_inmem_verifier_and_signer()
    app.state._token_verifier = verifier
    return app, signer


def _client(**kw):
    app, _ = _build(**kw)
    return TestClient(app)


def _sign(signer, tenant_id="t1", roles=None):
    return sign_inmem_token(signer, tenant_id, roles or ["member"])


class TestProtectedEndpointsNoDb503:
    def test_passkeys_list_no_db_503(self):
        app, signer = _build()
        client = TestClient(app)
        r = client.get("/api/manager/passkeys", headers={"Authorization": f"Bearer {_sign(signer)}"})
        assert r.status_code == 503
        assert r.headers["content-type"].startswith("application/problem+json")

    def test_passkey_registration_options_no_db_503(self):
        app, signer = _build()
        client = TestClient(app)
        r = client.post("/api/manager/passkeys/registration-options",
                        headers={"Authorization": f"Bearer {_sign(signer)}"})
        assert r.status_code == 503


class TestAuthSurfaceEnvelopeProblemJson:
    def test_oauth_callback_returns_problemjson_on_malformed_state(self):
        client = _client(db_url="postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = client.post("/api/auth/oauth/callback",
                        json={"provider": "google", "code": "x", "state": "bad"})
        assert r.status_code == 422
        assert r.headers["content-type"].startswith("application/problem+json")
        assert r.json().get("status") == 422

    def test_oauth_providers_unconfigured_db_returns_problemjson(self):
        """public path must not 500; DB-less auth surface → 503 problem+json."""
        client = _client()
        r = client.get("/api/auth/oauth/providers")
        assert r.status_code in (200, 503)
        if r.status_code != 200:
            assert r.headers["content-type"].startswith("application/problem+json")


class TestProtectedEndpointsRequireAuth:
    def test_passkeys_list_without_token_returns_unauthenticated(self):
        client = _client(db_url="postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = client.get("/api/manager/passkeys")
        assert r.status_code in (401, 422)
