"""Contract tests for the signed service-to-service trust boundary."""

from __future__ import annotations

import json
import time

import httpx
import jwt
import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient

from shared.auth import generate_rsa_keypair
from shared.errors import Forbidden, Unauthorized, install_exception_handlers
from shared.service_client import ServiceClient
from shared.service_identity import (
    MAX_ASSERTION_TTL_SECONDS,
    ServiceIdentitySigner,
    ServiceIdentityVerifier,
)
from shared.service_token import service_target_binding_policy, verify_service_token


_PRIVATE_KEY, _PUBLIC_KEY = generate_rsa_keypair()


def _verifier(*, replay_cache=None, scopes=("enterprise:provision", "owner:bootstrap", "notification:write")):
    return ServiceIdentityVerifier(
        {
            "operation-key": {
                "public_key": _PUBLIC_KEY,
                "issuer": "operation-issuer",
                "subject": "operation-service",
                "deployment_id": "operation-deployment",
                "audiences": ["aiteam-manager-service"],
                "enterprise_ids": ["enterprise-a"],
                "tenant_ids": ["tenant-a"],
                "scopes": list(scopes),
            }
        },
        expected_audience="aiteam-manager-service",
        replay_cache=replay_cache,
    )


def _signer(*, ttl=30, clock=None):
    return ServiceIdentitySigner(
        _PRIVATE_KEY,
        kid="operation-key",
        issuer="operation-issuer",
        subject="operation-service",
        deployment_id="operation-deployment",
        ttl_seconds=ttl,
        clock=clock,
    )


def _strict_verifier(*, status="active", target_bindings=None, not_before=None, expires_at=None):
    now = int(time.time())
    return ServiceIdentityVerifier(
        {
            "operation-key": {
                "public_key": _PUBLIC_KEY,
                "issuer": "operation-issuer",
                "subject": "operation-service",
                "deployment_id": "operation-deployment",
                "audiences": ["aiteam-manager-service"],
                "origins": ["https://manager.invalid"],
                "scopes": ["enterprise:provision", "owner:bootstrap", "notification:write"],
                "provisioning_capabilities": ["provision-enterprise"],
                "status": status,
                "not_before": now - 30 if not_before is None else not_before,
                "expires_at": now + 300 if expires_at is None else expires_at,
                "target_bindings": (
                    [
                    {"enterprise_id": "enterprise-a", "tenant_id": "tenant-a", "origin": "https://manager.invalid"},
                    {"enterprise_id": "enterprise-a", "origin": "https://manager.invalid"},
                    {"tenant_id": "tenant-a", "origin": "https://manager.invalid"},
                    ]
                    if target_bindings is None
                    else target_bindings
                ),
            }
        },
        expected_audience="aiteam-manager-service",
        expected_origin="https://manager.invalid",
        require_scope_binding=True,
        require_origin_binding=True,
        single_instance=True,
    )


def _app(verifier=None, *, settings=None):
    app = FastAPI()
    install_exception_handlers(app)
    app.state.settings = settings or type(
        "Settings",
        (),
        {
            "aiteam_env": "production",
            "service_name": "aiteam-manager-service",
            "service_identity_audience": "aiteam-manager-service",
            "service_identity_origin": "https://manager.invalid",
            "service_token": "should-never-be-used",
        },
    )()
    app.state.service_identity_verifier = verifier or _verifier()

    @app.post("/api/manager/tenants")
    def provision(body: dict, request: Request, _guard=Depends(verify_service_token)):
        return {
            "ok": True,
            "tenant_id": request.state.service_tenant_id,
            "enterprise_id": request.state.service_enterprise_id,
        }

    @app.post("/api/manager/owner-bootstrap")
    def owner_bootstrap(body: dict, request: Request, _guard=Depends(verify_service_token)):
        return {
            "ok": True,
            "tenant_id": request.state.service_tenant_id,
            "enterprise_id": request.state.service_enterprise_id,
        }

    return app


def _transport(app):
    def handler(request: httpx.Request) -> httpx.Response:
        with TestClient(app) as client:
            response = client.request(
                request.method,
                str(request.url),
                headers=dict(request.headers),
                content=request.content,
            )
        return httpx.Response(
            response.status_code,
            headers=response.headers,
            content=response.content,
        )

    return httpx.MockTransport(handler)


def test_signed_client_sends_fresh_authorization_and_verified_scope():
    app = _app()
    client = ServiceClient(
        "https://manager.invalid",
        service_identity="operation-service",
        service_signer=_signer(),
        service_audience="aiteam-manager-service",
        aiteam_env="production",
        transport=_transport(app),
    )

    first = client.post(
        "/api/manager/tenants",
        {"enterprise_id": "enterprise-a", "tenant_id": "tenant-a"},
        service_purpose="enterprise:provision",
        service_enterprise_id="enterprise-a",
        service_tenant_id="tenant-a",
    )
    second = client.post(
        "/api/manager/tenants",
        {"enterprise_id": "enterprise-a", "tenant_id": "tenant-a"},
        service_purpose="enterprise:provision",
        service_enterprise_id="enterprise-a",
        service_tenant_id="tenant-a",
    )

    assert first == {"ok": True, "tenant_id": "tenant-a", "enterprise_id": "enterprise-a"}
    assert second == first
    client.close()


def test_f01_route_requires_provisioning_capability_claim():
    app = _app(_strict_verifier(target_bindings=[]))
    client = ServiceClient(
        "https://manager.invalid",
        service_identity="operation-service",
        service_signer=_signer(),
        service_audience="aiteam-manager-service",
        aiteam_env="production",
        transport=_transport(app),
    )
    body = {"enterprise_id": "enterprise-new", "tenant_id": "tenant-new"}
    with pytest.raises(Forbidden):
        client.post(
            "/api/manager/tenants",
            body,
            idempotency_key="provision-missing-capability",
            service_purpose="enterprise:provision",
            service_tenant_id="tenant-new",
            service_enterprise_id="enterprise-new",
        )
    with pytest.raises(Forbidden):
        client.post(
            "/api/manager/tenants",
            body,
            idempotency_key="provision-wrong-capability",
            service_purpose="enterprise:provision",
            service_capability="enterprise:provision",
            service_tenant_id="tenant-new",
            service_enterprise_id="enterprise-new",
        )
    assert client.post(
        "/api/manager/tenants",
        body,
        idempotency_key="provision-correct-capability",
        service_purpose="enterprise:provision",
        service_capability="provision-enterprise",
        service_tenant_id="tenant-new",
        service_enterprise_id="enterprise-new",
    )["ok"] is True
    client.close()


def test_signed_f02_assertion_is_tenant_only_end_to_end():
    app = _app(_strict_verifier())
    client = ServiceClient(
        "https://manager.invalid",
        service_identity="operation-service",
        service_signer=_signer(),
        service_audience="aiteam-manager-service",
        aiteam_env="production",
        transport=_transport(app),
    )
    valid = client.post(
        "/api/manager/owner-bootstrap",
        {"tenant_id": "tenant-a", "owner_phone": "13800000000", "bootstrap_secret": "test"},
        idempotency_key="bootstrap-1",
        service_purpose="owner:bootstrap",
        service_tenant_id="tenant-a",
    )
    assert valid == {"ok": True, "tenant_id": "tenant-a", "enterprise_id": None}

    with pytest.raises(Forbidden):
        client.post(
            "/api/manager/owner-bootstrap",
            {"tenant_id": "tenant-a", "owner_phone": "13800000000", "bootstrap_secret": "test"},
            idempotency_key="bootstrap-2",
            service_purpose="owner:bootstrap",
            service_enterprise_id="enterprise-a",
            service_tenant_id="tenant-a",
        )
    client.close()


def test_production_strict_manifest_requires_exact_target_binding():
    verifier = _strict_verifier(
        target_bindings=[
            {"enterprise_id": "enterprise-a", "tenant_id": "tenant-a", "origin": "https://manager.invalid"}
        ]
    )
    signer = _signer()
    body = b'{"enterprise_id":"enterprise-a","tenant_id":"tenant-b"}'
    token = signer.sign(
        audience="aiteam-manager-service",
        scope=["enterprise:provision"],
        enterprise_id="enterprise-a",
        tenant_id="tenant-b",
        path="/api/manager/tenants",
        body=body,
        origin="https://manager.invalid",
    )
    with pytest.raises(Forbidden):
        verifier.verify(
            token,
            path="/api/manager/tenants",
            body=body,
            required_scope="enterprise:provision",
            required_enterprise_id="enterprise-a",
            required_tenant_id="tenant-b",
            require_enterprise_scope=True,
            target_binding="enterprise-tenant",
            expected_origin="https://manager.invalid",
        )


def test_f01_fresh_ids_require_registered_non_wildcard_capability():
    verifier = _strict_verifier(target_bindings=[])
    signer = _signer()
    body = b'{"enterprise_id":"enterprise-new","tenant_id":"tenant-new"}'
    token = signer.sign(
        audience="aiteam-manager-service",
        scope=["enterprise:provision"],
        capability="provision-enterprise",
        enterprise_id="enterprise-new",
        tenant_id="tenant-new",
        path="/api/manager/tenants",
        body=body,
        origin="https://manager.invalid",
    )
    principal = verifier.verify(
        token,
        path="/api/manager/tenants",
        body=body,
        required_scope="enterprise:provision",
        required_capability="provision-enterprise",
        required_enterprise_id="enterprise-new",
        required_tenant_id="tenant-new",
        require_enterprise_scope=True,
        target_binding="provision-enterprise",
        expected_origin="https://manager.invalid",
    )
    assert principal.enterprise_id == "enterprise-new"
    assert principal.tenant_id == "tenant-new"
    assert principal.capability == "provision-enterprise"


def test_wildcard_signed_ids_are_rejected():
    with pytest.raises(ValueError):
        _signer().sign(
            audience="aiteam-manager-service",
            scope=["enterprise:provision"],
            capability="provision-enterprise",
            enterprise_id="enterprise-*",
            tenant_id="tenant-a",
            path="/api/manager/tenants",
            body=b'{"enterprise_id":"enterprise-*","tenant_id":"tenant-a"}',
            origin="https://manager.invalid",
        )

    token = _signer().sign(
        audience="aiteam-manager-service",
        scope=["enterprise:provision"],
        capability="provision-enterprise",
        enterprise_id="enterprise-a",
        tenant_id="tenant-a",
        path="/api/manager/tenants",
        body=b'{"enterprise_id":"enterprise-a","tenant_id":"tenant-a"}',
        origin="https://manager.invalid",
    )
    with pytest.raises(Unauthorized):
        _strict_verifier(target_bindings=[]).verify(
            token,
            path="/api/manager/tenants",
            body=b'{"enterprise_id":"enterprise-*","tenant_id":"tenant-a"}',
            required_scope="enterprise:provision",
            required_capability="provision-enterprise",
            required_enterprise_id="enterprise-*",
            required_tenant_id="tenant-a",
            require_enterprise_scope=True,
            target_binding="provision-enterprise",
            expected_origin="https://manager.invalid",
        )


def test_production_key_status_and_validity_are_enforced():
    signer = _signer()
    token = signer.sign(
        audience="aiteam-manager-service",
        scope=["enterprise:provision"],
        enterprise_id="enterprise-a",
        tenant_id="tenant-a",
        path="/api/manager/tenants",
        body=b'{"enterprise_id":"enterprise-a","tenant_id":"tenant-a"}',
        origin="https://manager.invalid",
    )
    for key_status in ("revoked", "disabled"):
        verifier = _strict_verifier(status=key_status)
        with pytest.raises(Unauthorized):
            verifier.verify(
                token,
                path="/api/manager/tenants",
                body=b'{"enterprise_id":"enterprise-a","tenant_id":"tenant-a"}',
                required_scope="enterprise:provision",
                required_enterprise_id="enterprise-a",
                required_tenant_id="tenant-a",
                require_enterprise_scope=True,
                target_binding="provision-enterprise",
                expected_origin="https://manager.invalid",
            )


def test_production_key_validity_window_is_enforced():
    signer = _signer()
    body = b'{"enterprise_id":"enterprise-a","tenant_id":"tenant-a"}'
    token = signer.sign(
        audience="aiteam-manager-service",
        scope=["enterprise:provision"],
        enterprise_id="enterprise-a",
        tenant_id="tenant-a",
        path="/api/manager/tenants",
        body=body,
        origin="https://manager.invalid",
    )
    now = int(time.time())
    for kwargs in (
        {"not_before": now + 120},
        {"not_before": now - 3600, "expires_at": now - 60},
    ):
        verifier = _strict_verifier(**kwargs)
        with pytest.raises(Unauthorized):
            verifier.verify(
                token,
                path="/api/manager/tenants",
                body=body,
                required_scope="enterprise:provision",
                required_enterprise_id="enterprise-a",
                required_tenant_id="tenant-a",
                require_enterprise_scope=True,
                target_binding="provision-enterprise",
                expected_origin="https://manager.invalid",
            )


def test_signed_calls_require_https_target_origin():
    with pytest.raises(ValueError):
        ServiceClient(
            "http://manager.invalid",
            service_signer=_signer(),
            service_audience="aiteam-manager-service",
            aiteam_env="production",
        )


def test_signed_verifier_rejects_http_origin_in_production():
    verifier = _strict_verifier()
    signer = _signer()
    body = b'{"enterprise_id":"enterprise-a","tenant_id":"tenant-a"}'
    token = signer.sign(
        audience="aiteam-manager-service",
        scope=["enterprise:provision"],
        enterprise_id="enterprise-a",
        tenant_id="tenant-a",
        path="/api/manager/tenants",
        body=body,
        origin="http://manager.invalid",
    )
    with pytest.raises(Unauthorized):
        verifier.verify(
            token,
            path="/api/manager/tenants",
            body=body,
            required_scope="enterprise:provision",
            required_enterprise_id="enterprise-a",
            required_tenant_id="tenant-a",
            require_enterprise_scope=True,
            target_binding="provision-enterprise",
            expected_origin="https://manager.invalid",
        )


def test_idempotency_key_is_bound_to_assertion():
    signer = _signer()
    verifier = _verifier()
    body = b'{"enterprise_id":"enterprise-a","tenant_id":"tenant-a"}'
    token = signer.sign(
        audience="aiteam-manager-service",
        scope=["enterprise:provision"],
        enterprise_id="enterprise-a",
        tenant_id="tenant-a",
        path="/api/manager/tenants",
        body=body,
        origin="https://manager.invalid",
        idempotency_key="operation-a",
    )
    with pytest.raises(Unauthorized):
        verifier.verify(
            token,
            path="/api/manager/tenants",
            body=body,
            required_scope="enterprise:provision",
            required_enterprise_id="enterprise-a",
            required_tenant_id="tenant-a",
            require_enterprise_scope=True,
            target_binding="provision-enterprise",
            expected_origin="https://manager.invalid",
            expected_idempotency_key="operation-b",
        )


def test_signed_client_refuses_redirect_response():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(307, headers={"location": "https://evil.invalid"})

    client = ServiceClient(
        "https://manager.invalid",
        service_signer=_signer(),
        service_audience="aiteam-manager-service",
        aiteam_env="production",
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(Unauthorized):
        client.get("/api/manager/tenants")
    client.close()


def test_production_settings_without_trust_manifest_fail_closed():
    class _Settings:
        aiteam_env = "production"
        service_name = "aiteam-manager-service"
        service_identity_audience = "aiteam-manager-service"
        service_identity_origin = "https://manager.invalid"
        service_identity_public_keys = {"operation-key": _PUBLIC_KEY}
        service_identity_trust = {}
        service_identity_single_instance = True
        service_identity_clock_skew_seconds = 30
        service_identity_allowed_origins = ()
        service_identity_allowed_enterprises = ()
        service_identity_allowed_tenants = ()
        service_identity_allowed_scopes = ()
        service_token = "must-not-be-used"

    app = _app(settings=_Settings())
    # _app injects the unit verifier by default; replace it to exercise the
    # real settings-built verifier path.
    del app.state.service_identity_verifier
    client = TestClient(app)
    response = client.post(
        "/api/manager/tenants",
        json={"enterprise_id": "enterprise-a", "tenant_id": "tenant-a"},
        headers={"X-Service-Token": "must-not-be-used"},
    )
    assert response.status_code == 401


def test_platform_catalog_uses_exact_tenant_only_binding():
    assert service_target_binding_policy("/api/operation/catalog/platform-providers") == ("tenant-only", True)


def test_platform_catalog_signed_call_has_tenant_only_target():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        token = request.headers["Authorization"].removeprefix("Bearer ")
        seen["claims"] = jwt.decode(token, options={"verify_signature": False})
        return httpx.Response(200, json={"data": {}})

    client = ServiceClient(
        "https://operation.invalid",
        service_identity="manager-service",
        service_signer=_signer(),
        service_audience="aiteam-operation-service",
        aiteam_env="production",
        transport=httpx.MockTransport(handler),
    )
    client.get(
        "/api/operation/catalog/platform-providers?tenant_id=tenant-a",
        service_purpose="catalog:read",
        service_tenant_id="tenant-a",
    )
    assert seen["claims"]["scope"] == ["catalog:read"]
    assert seen["claims"]["tenant_id"] == "tenant-a"
    assert "enterprise_id" not in seen["claims"]
    client.close()


def test_service_client_uses_peer_audience_and_safe_default_ttl(monkeypatch):
    monkeypatch.setenv("SERVICE_IDENTITY_PEER_AUDIENCE", "peer-audience")
    monkeypatch.setenv("SERVICE_IDENTITY_AUDIENCE", "local-audience")
    monkeypatch.setenv("SERVICE_IDENTITY_TTL_SECONDS", "")
    client = ServiceClient(
        "https://manager.invalid",
        service_private_key=_PRIVATE_KEY,
        service_key_id="operation-key",
        service_issuer="operation-issuer",
        service_deployment_id="operation-deployment",
        service_identity="operation-service",
        aiteam_env="production",
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"ok": True})),
    )
    assert client._service_audience == "peer-audience"
    assert client._service_signer.ttl_seconds == 30
    client.close()


def test_service_client_derives_future_rollup_scope_from_body():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        token = request.headers["Authorization"].removeprefix("Bearer ")
        seen["claims"] = jwt.decode(token, options={"verify_signature": False})
        return httpx.Response(202, json={"ok": True})

    client = ServiceClient(
        "https://operator.invalid",
        service_identity="manager-service",
        service_signer=_signer(),
        service_audience="aiteam-operation-service",
        aiteam_env="production",
        transport=httpx.MockTransport(handler),
    )
    assert client.post(
        "/api/operation/rollups",
        {"enterprise_id": "enterprise-a", "tenant_id": "tenant-a", "summaries": []},
        idempotency_key="rollup-1",
    ) == {"ok": True}
    assert seen["claims"]["scope"] == ["rollup:write"]
    assert seen["claims"]["enterprise_id"] == "enterprise-a"
    assert seen["claims"]["tenant_id"] == "tenant-a"
    client.close()


def test_production_never_falls_back_to_shared_token():
    seen = {"requests": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        seen["requests"] += 1
        return httpx.Response(200, json={"ok": True})

    client = ServiceClient(
        "https://manager.invalid",
        service_identity="operation-service",
        service_token="forgeable-shared-secret",
        aiteam_env="production",
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(Unauthorized):
        client.post("/api/manager/tenants", {"tenant_id": "tenant-a"})
    assert seen["requests"] == 0
    client.close()


def test_forged_identity_label_and_shared_header_are_rejected_in_production():
    app = _app()
    client = TestClient(app)
    body = {"enterprise_id": "enterprise-a", "tenant_id": "tenant-a"}

    forged_label = client.post(
        "/api/manager/tenants",
        json=body,
        headers={"X-Service-Identity": "operation-service"},
    )
    shared_header = client.post(
        "/api/manager/tenants",
        json=body,
        headers={"X-Service-Token": "should-never-be-used"},
    )

    assert forged_label.status_code == 401
    assert shared_header.status_code == 401


def test_signed_target_scope_mismatch_is_forbidden():
    app = _app()
    client = ServiceClient(
        "https://manager.invalid",
        service_identity="operation-service",
        service_signer=_signer(),
        service_audience="aiteam-manager-service",
        aiteam_env="production",
        transport=_transport(app),
    )
    with pytest.raises(Forbidden):
        client.post(
            "/api/manager/tenants",
            {"enterprise_id": "enterprise-other", "tenant_id": "tenant-a"},
            service_purpose="enterprise:provision",
            service_enterprise_id="enterprise-other",
            service_tenant_id="tenant-a",
        )
    client.close()


def test_replayed_assertion_is_rejected():
    app = _app()
    signer = _signer()
    body = {"enterprise_id": "enterprise-a", "tenant_id": "tenant-a"}
    body_bytes = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    token = signer.sign(
        audience="aiteam-manager-service",
        scope=["enterprise:provision"],
        enterprise_id="enterprise-a",
        tenant_id="tenant-a",
        path="/api/manager/tenants",
        body=body_bytes,
        origin="https://manager.invalid",
        idempotency_key="provision-1",
        jti="one-use-only",
    )
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Idempotency-Key": "provision-1",
    }
    client = TestClient(app)
    first = client.post("/api/manager/tenants", headers=headers, content=body_bytes)
    replay = client.post("/api/manager/tenants", headers=headers, content=body_bytes)
    assert first.status_code == 200
    assert replay.status_code == 401


def test_assertion_lifetime_is_bounded_to_sixty_seconds():
    with pytest.raises(ValueError):
        _signer(ttl=MAX_ASSERTION_TTL_SECONDS + 1)


def test_wrong_path_and_body_binding_do_not_verify():
    signer = _signer()
    verifier = _verifier()
    token = signer.sign(
        audience="aiteam-manager-service",
        scope=["enterprise:provision"],
        enterprise_id="enterprise-a",
        tenant_id="tenant-a",
        path="/api/manager/tenants",
        body=b'{"enterprise_id":"enterprise-a","tenant_id":"tenant-a"}',
    )
    with pytest.raises(Unauthorized):
        verifier.verify(
            token,
            path="/api/manager/owner-bootstrap",
            body=b'{"enterprise_id":"enterprise-a","tenant_id":"tenant-a"}',
            required_scope="enterprise:provision",
            required_enterprise_id="enterprise-a",
            required_tenant_id="tenant-a",
        )


def test_user_jwt_shaped_bearer_is_not_legacy_service_token():
    app = _app()
    client = TestClient(app)
    fake_user_jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature"
    response = client.post(
        "/api/manager/tenants",
        json={"enterprise_id": "enterprise-a", "tenant_id": "tenant-a"},
        headers={"Authorization": f"Bearer {fake_user_jwt}"},
    )
    assert response.status_code == 401
