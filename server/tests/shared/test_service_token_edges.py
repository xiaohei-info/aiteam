from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

import shared.service_token as service_token
from shared.errors import Unauthorized, install_exception_handlers
from shared.service_identity import ServiceIdentityVerifier


def request(*, body=b"", headers=None, query="", verifier=None, settings=None):
    return SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(
            settings=settings or SimpleNamespace(
                aiteam_env="development", service_name="manager-service",
                service_identity_origin=None, service_identity_audience="audience",
                service_token="legacy", service_auth_mode="auto",
            ),
            service_identity_verifier=verifier,
        )),
        headers=headers or {},
        _body=body,
        url=SimpleNamespace(path="/api/manager/tenants", query=query),
        query_params={"tenant_id": "tenant-a"},
        state=SimpleNamespace(),
    )


def test_service_policy_helpers_cover_prefixes_and_body_targets():
    assert service_token.required_service_scope("/api/operation/catalog/pull/expert") == "catalog:read"
    assert service_token.required_service_scope("/api/operation/skill-market/pull/skills") == "catalog:read"
    assert service_token.required_service_scope("/api/manager/enterprise-policy/tenant") == "enterprise-policy:write"
    assert service_token.required_service_scope("/api/operation/enterprise-policy/tenant") == "enterprise-policy:read"
    assert service_token.service_target_binding_policy("/api/manager/enterprise-policy/tenant") == ("enterprise-tenant", False)
    assert service_token.service_target_binding_policy("/api/manager/no-policy") == (None, False)
    assert service_token._json_target(b"not-json", request()) == (None, "tenant-a")
    assert service_token._json_target(b'{"org_id":"e1","tenant_id":"t1"}', request()) == ("e1", "t1")
    with pytest.raises(Unauthorized):
        service_token._json_target(b'{"tenant_id":"t*"}', request())


def test_service_verifier_cache_and_signed_boundary_fail_closed():
    app = FastAPI()
    install_exception_handlers(app)
    app.state.settings = SimpleNamespace(
        aiteam_env="development", service_name="manager-service",
        service_identity_origin=None, service_identity_audience="audience",
        service_token="legacy", service_auth_mode="signed",
        service_identity_trust={}, service_identity_public_keys={},
    )
    app.state._service_identity_verifier = object()

    @app.post("/protected")
    def protected(_=Depends(service_token.verify_service_token)):
        return {"ok": True}

    assert TestClient(app).post("/protected").status_code == 401


def test_signed_request_passes_verified_principal_and_body_scope_to_verifier():
    class CapturingVerifier(ServiceIdentityVerifier):
        def __init__(self):
            pass

        def verify(self, token, **kwargs):
            assert token == "signed-token"
            assert kwargs["required_scope"] == "enterprise:provision"
            assert kwargs["required_enterprise_id"] == "enterprise-a"
            assert kwargs["required_tenant_id"] == "tenant-a"
            return SimpleNamespace(
                tenant_id="tenant-a", enterprise_id="enterprise-a", scopes=("enterprise:provision",),
            )

    request_value = request(
        body=b'{"enterprise_id":"enterprise-a","tenant_id":"tenant-a"}',
        headers={"Authorization": "Bearer signed-token", "Idempotency-Key": "provision-1"},
        verifier=CapturingVerifier(),
        settings=SimpleNamespace(
            aiteam_env="production", service_name="manager-service",
            service_identity_origin="https://manager.example", service_identity_audience="audience",
            service_token="legacy", service_auth_mode="signed",
        ),
    )
    principal = service_token._verify_signed(request_value, request_value.app.state.service_identity_verifier)
    assert principal.tenant_id == "tenant-a"
    assert request_value.state.service_enterprise_id == "enterprise-a"


def test_legacy_and_mode_errors_are_explicit():
    app = FastAPI()
    install_exception_handlers(app)
    app.state.settings = SimpleNamespace(
        aiteam_env="development", service_name="manager-service",
        service_identity_origin=None, service_identity_audience=None,
        service_token=None, service_auth_mode="invalid",
    )

    @app.post("/protected")
    def protected(_=Depends(service_token.verify_service_token)):
        return {"ok": True}

    assert TestClient(app).post("/protected").status_code == 401
