from types import SimpleNamespace

import pytest

import manager_service.service_ingress as ingress
from manager_service.service_ingress import canonical_body_sha256, validate_onboarding_principal
from shared.errors import Forbidden, Unauthorized


_ORIGIN = "https://operator.example.test"
_ENTERPRISE = "11111111-1111-4111-8111-111111111111"
_TENANT = "22222222-2222-4222-8222-222222222222"


def _request(*, registration=None, env="test", path="/api/manager/tenants", headers=None):
    state = SimpleNamespace(
        settings=SimpleNamespace(aiteam_env=env),
        service_identity_trust=registration,
    )
    return SimpleNamespace(
        app=SimpleNamespace(state=state),
        url=SimpleNamespace(path=path),
        headers=headers or {"Idempotency-Key": "provision-1"},
    )


def _principal(**updates):
    values = {
        "iss": "https://trust.example.test",
        "sub": "operator-provisioner",
        "aud": "manager-service",
        "purpose": "service",
        "deployment_id": "operator-prod",
        "enterprise_id": _ENTERPRISE,
        "tenant_id": _TENANT,
        "scope": ("enterprise:provision",),
        "origin": _ORIGIN,
        "capability": "provision-enterprise",
        "kid": "operator-kid-1",
        "path": "/api/manager/tenants",
        "idempotency_key": "provision-1",
    }
    values.update(updates)
    return SimpleNamespace(**values)


def _registration(**updates):
    values = {
        "status": "active",
        "issuer": "https://trust.example.test",
        "subject": "operator-provisioner",
        "deployment_id": "operator-prod",
        "audiences": ["manager-service"],
        "origins": [_ORIGIN],
        "scopes": ["enterprise:provision"],
        "provisioning_capabilities": ["provision-enterprise"],
        "target_bindings": [{"enterprise_id": _ENTERPRISE, "tenant_id": _TENANT, "origin": _ORIGIN}],
    }
    values.update(updates)
    return {"operator-kid-1": values}


def test_f01_consumes_explicit_registered_provisioning_principal_and_origin():
    request = _request(registration=_registration())
    result = validate_onboarding_principal(
        request,
        _principal(),
        operation="provision",
        enterprise_id=_ENTERPRISE,
        tenant_id=_TENANT,
    )
    assert result is not None
    assert result.principal.kid == "operator-kid-1"


def test_signed_f01_body_path_and_idempotency_binding_are_exact():
    body = {"enterprise_id": _ENTERPRISE, "tenant_id": _TENANT, "enterprise_name": "Acme"}
    principal = _principal(body_sha256=canonical_body_sha256(body))
    result = validate_onboarding_principal(
        _request(registration=_registration(), headers={"Idempotency-Key": "provision-1"}),
        principal,
        operation="provision",
        enterprise_id=_ENTERPRISE,
        tenant_id=_TENANT,
        body=body,
        idempotency_key="provision-1",
    )
    assert result is not None

    with pytest.raises(Forbidden):
        validate_onboarding_principal(
            _request(registration=_registration(), headers={"Idempotency-Key": "provision-1"}),
            _principal(body_sha256="0" * 64),
            operation="provision",
            enterprise_id=_ENTERPRISE,
            tenant_id=_TENANT,
            body=body,
            idempotency_key="provision-1",
        )


def test_f01_rejects_existing_target_claim_and_wildcard_registration():
    with pytest.raises(Forbidden):
        validate_onboarding_principal(
            _request(registration=_registration()),
            _principal(tenant_id="33333333-3333-4333-8333-333333333333"),
            operation="provision",
            enterprise_id=_ENTERPRISE,
            tenant_id=_TENANT,
        )

    wildcard = _registration(origins=["*"])
    with pytest.raises(Forbidden):
        validate_onboarding_principal(_request(registration=wildcard), _principal(), operation="provision")

    # F01 is capability-authorized before the post-F01 binding exists; an
    # empty target list is valid, while null/origin-only tuples are ignored
    # rather than treated as a wildcard.
    no_static_target = _registration(target_bindings=[])
    result = validate_onboarding_principal(
        _request(registration=no_static_target),
        _principal(),
        operation="provision",
        enterprise_id=_ENTERPRISE,
        tenant_id=_TENANT,
    )
    assert result is not None


def test_service_ingress_helpers_and_registration_fail_closed():
    assert ingress._field({"other": 1}, "missing", "alias") is None
    assert ingress._as_strings("scope") == ("scope",)
    assert ingress._as_strings(["scope", 1]) == ("scope", "1")
    assert ingress._as_strings(1) == ()
    assert ingress._without_none({"a": None, "nested": {"b": None, "c": 1}, "items": [None, 2]}) == {"nested": {"c": 1}, "items": [None, 2]}
    assert ingress._registration_map(_request(registration=None)) is None
    settings_request = _request(registration=None)
    settings_request.app.state.service_identity_trust = None
    settings_request.app.state.settings.service_identity_trust = _registration()
    assert ingress._registration_map(settings_request) == _registration()
    assert ingress._registration_for(_request(registration=None), _principal()) is None
    with pytest.raises(Unauthorized):
        ingress._registration_for(_request(registration=_registration()), _principal(kid=""))
    with pytest.raises(Forbidden):
        ingress._registration_for(_request(registration=None, env="production"), _principal())
    with pytest.raises(Forbidden):
        ingress._registration_for(_request(registration={}), _principal())
    with pytest.raises(Forbidden):
        ingress._registration_for(_request(registration=_registration(status="disabled")), _principal())
    with pytest.raises(Forbidden):
        ingress._registration_for(_request(registration=_registration()), _principal(sub="other"))
    with pytest.raises(Forbidden):
        ingress._registration_for(_request(registration=_registration(audiences=["other"])), _principal())
    with pytest.raises(Forbidden):
        ingress._registration_for(_request(registration=_registration(origins=["https://other.example"])), _principal())
    with pytest.raises(Forbidden):
        ingress._registration_for(_request(registration=_registration(origins=["http://operator.example.test"])), _principal())
    with pytest.raises(Forbidden):
        ingress._registration_for(_request(registration=_registration(origins=["http://operator.example.test"])), _principal(origin="http://operator.example.test"))
    with pytest.raises(Forbidden):
        ingress._registration_for(_request(registration=_registration(scopes=["scope*"])), _principal())


def test_service_ingress_bootstrap_notification_and_proof_rejections():
    from pydantic import BaseModel

    class Body(BaseModel):
        value: str | None = None

    assert len(canonical_body_sha256(Body(value="x"))) == 64
    registration = _registration()
    with pytest.raises(Forbidden):
        validate_onboarding_principal(_request(registration=registration, path="/api/manager/owner-bootstrap"), _principal(scope=("owner:bootstrap",), capability="owner-bootstrap", enterprise_id=None), operation="bootstrap", tenant_id=_TENANT)
    with pytest.raises(Forbidden):
        validate_onboarding_principal(_request(registration=registration), _principal(purpose="wrong"), operation="provision", enterprise_id=_ENTERPRISE, tenant_id=_TENANT)
    with pytest.raises(Forbidden):
        validate_onboarding_principal(_request(registration=registration), _principal(scope=("other",)), operation="provision", enterprise_id=_ENTERPRISE, tenant_id=_TENANT)
    with pytest.raises(Forbidden):
        validate_onboarding_principal(_request(registration=registration), _principal(capability="other"), operation="provision", enterprise_id=_ENTERPRISE, tenant_id=_TENANT)
    with pytest.raises(Forbidden):
        validate_onboarding_principal(_request(registration=registration), _principal(tenant_id="tenant*"), operation="provision", enterprise_id=_ENTERPRISE, tenant_id=_TENANT)
    with pytest.raises(Forbidden):
        validate_onboarding_principal(_request(registration=registration), _principal(idempotency_key="signed-other"), operation="provision", enterprise_id=_ENTERPRISE, tenant_id=_TENANT)
    with pytest.raises(Forbidden):
        validate_onboarding_principal(_request(registration=registration, headers={}), _principal(idempotency_key=None), operation="provision", enterprise_id=_ENTERPRISE, tenant_id=_TENANT)
    with pytest.raises(Forbidden):
        validate_onboarding_principal(_request(registration=registration), _principal(enterprise_id=None, tenant_id=_TENANT), operation="notification", enterprise_id=_ENTERPRISE, tenant_id=_TENANT)
    bootstrap = _registration(status="active", scopes=["owner:bootstrap"], provisioning_capabilities=["owner-bootstrap"])
    bootstrap_principal = _principal(scope=("owner:bootstrap",), capability="owner-bootstrap", enterprise_id=None, path="/api/manager/owner-bootstrap")
    assert validate_onboarding_principal(_request(registration=bootstrap, path="/api/manager/owner-bootstrap"), bootstrap_principal, operation="bootstrap", tenant_id=_TENANT) is not None
    notification = _registration(status="active", scopes=["notification:write"], provisioning_capabilities=["enterprise-notification"])
    notification_principal = _principal(scope=("notification:write",), capability="enterprise-notification", path="/api/manager/enterprise/notify")
    assert validate_onboarding_principal(_request(registration=notification, path="/api/manager/enterprise/notify"), notification_principal, operation="notification", enterprise_id=_ENTERPRISE, tenant_id=_TENANT) is not None
    with pytest.raises(Forbidden):
        validate_onboarding_principal(_request(registration=notification, path="/api/manager/enterprise/notify"), notification_principal, operation="notification", enterprise_id="other", tenant_id=_TENANT)


def test_service_tenant_context_uses_verified_state_only(monkeypatch):
    request = _request(registration=None)
    request.state = SimpleNamespace(service_tenant_id=_TENANT)
    monkeypatch.setattr(ingress, "require_operator_service_principal", lambda _request: None)
    assert ingress.service_tenant_context(request).tenant_id == _TENANT
    request.state.service_tenant_id = None
    with pytest.raises(Unauthorized):
        ingress.service_tenant_context(request)


def test_production_missing_principal_fails_closed_without_header_fallback():
    with pytest.raises(Unauthorized):
        # ``validate_onboarding_principal`` is deliberately the post-verifier
        # seam; production still rejects a missing signed principal here.
        validate_onboarding_principal(_request(env="production"), None, operation="provision")
