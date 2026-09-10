"""Manager consumers for the authenticated service-trust lane.

The shared verifier owns signature, issuer, audience, time-window and body/path
proof validation.  Manager only consumes its verified ``request.state``
principal and applies the onboarding capability/target contract.  It never
accepts ``X-Service-Identity`` as an authorization fallback.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from fastapi import Request

from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden, Unauthorized
from shared.service_token import verify_service_token

from .multitenancy_phase import test_onboarding_writes_enabled

_REQUIRED_SCOPES = {
    "provision": "enterprise:provision",
    "bootstrap": "owner:bootstrap",
    "notification": "notification:write",
}
_REQUIRED_CAPABILITIES = {
    "provision": "provision-enterprise",
    "bootstrap": "owner-bootstrap",
    "notification": "enterprise-notification",
}


@dataclass(frozen=True)
class ServiceTrustContext:
    """A verified principal plus its explicit registration entry.

    ``principal`` remains the shared ``ServicePrincipal`` object.  The wrapper
    exists only to make the Manager authorization decision discoverable and to
    avoid defining another signing or token format here.
    """

    principal: Any
    registration: Mapping[str, Any] | Any | None


def _field(value: Any, name: str, *aliases: str) -> Any:
    if isinstance(value, Mapping):
        for candidate in (name, *aliases):
            if candidate in value:
                return value[candidate]
        return None
    for candidate in (name, *aliases):
        current = getattr(value, candidate, None)
        if current is not None:
            return current
    return None


def principal_field(principal: Any, name: str, *aliases: str) -> Any:
    return _field(principal, name, *aliases)


def _as_strings(value: Any) -> tuple[str, ...]:
    if isinstance(value, str):
        return (value,)
    if isinstance(value, (tuple, list, set, frozenset)):
        return tuple(str(item) for item in value)
    return ()


def _registration_map(request: Request) -> Mapping[str, Any] | None:
    # The shared trust lane exposes this map through Manager Settings in
    # production.  ``app.state`` is intentionally supported only as an explicit
    # test fixture seam; it is not read from a request header or env fallback.
    state_map = getattr(request.app.state, "service_identity_trust", None)
    if state_map is not None:
        return state_map
    settings = getattr(request.app.state, "settings", None)
    configured = getattr(settings, "service_identity_trust", None)
    return configured or None


def _registration_for(request: Request, principal: Any) -> Any | None:
    kid = principal_field(principal, "kid")
    if not isinstance(kid, str) or not kid or kid == "*":
        raise Unauthorized("verified service principal has no valid key id")
    configured = _registration_map(request)
    if configured is None:
        if getattr(request.app.state.settings, "aiteam_env", None) != "production":
            # Explicit synthetic principals are useful for unit tests and local
            # contract fixtures.  They still pass operation/target checks below.
            return None
        raise Forbidden("Manager service identity trust registry is not configured")
    if not isinstance(configured, Mapping) or kid not in configured:
        raise Forbidden("service principal is not registered for this Manager")
    entry = configured[kid]
    status = _field(entry, "status")
    if status not in {"active", "next"}:
        raise Forbidden("service principal registration is not active")
    for key in ("issuer", "subject", "deployment_id"):
        expected = _field(entry, key)
        actual = principal_field(principal, key, {"issuer": "iss", "subject": "sub"}.get(key, ""))
        if not isinstance(expected, str) or not expected or "*" in expected or actual != expected:
            raise Forbidden("service principal registration mismatch")
    audiences = _as_strings(_field(entry, "audiences"))
    principal_aud = _as_strings(principal_field(principal, "aud", "audience"))
    if not audiences or any(value == "*" for value in audiences) or not set(principal_aud).intersection(audiences):
        raise Forbidden("service principal audience is not registered")
    origins = _as_strings(_field(entry, "origins"))
    origin = principal_field(principal, "origin")
    if not isinstance(origin, str) or not origin or "*" in origin or origin not in origins:
        raise Forbidden("service principal origin is not registered")
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise Forbidden("service principal origin must be an exact HTTPS origin")
    for value in (*origins, *_as_strings(_field(entry, "scopes")), *_as_strings(_field(entry, "provisioning_capabilities"))):
        if "*" in value:
            raise Forbidden("wildcard service trust registration is not allowed")
    return entry


def require_operator_service_principal(request: Request) -> Any | None:
    """Verify the shared service lane and return its verified principal.

    The legacy shared-token check remains a prerequisite while deployments roll
    onto the signed lane.  Production never treats its absence as success.  In
    non-production, the absence is retained only for old phase-gate fixtures;
    positive onboarding tests should inject an explicit synthetic principal.
    """
    verify_service_token(request)
    principal = getattr(request.state, "service_principal", None)
    if principal is None:
        if getattr(request.app.state.settings, "aiteam_env", None) == "production":
            raise Unauthorized("verified signed service principal is required")
        return None
    _registration_for(request, principal)
    return principal


def _without_none(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _without_none(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_without_none(item) for item in value]
    return value


def canonical_body_sha256(body: Any) -> str:
    if hasattr(body, "model_dump"):
        body = body.model_dump(mode="json", exclude_none=True)
    canonical = json.dumps(
        _without_none(body),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _check_common_request_proof(
    request: Request,
    principal: Any,
    *,
    body: Any | None,
    idempotency_key: str | None,
    require_idempotency_key: bool,
) -> None:
    path = principal_field(principal, "path")
    if path is not None and path != request.url.path:
        raise Forbidden("signed service request path does not match")
    request_key = idempotency_key or request.headers.get("Idempotency-Key")
    signed_key = principal_field(principal, "idempotency_key")
    if require_idempotency_key and (not request_key or not signed_key):
        raise Forbidden("signed service idempotency key is required")
    if signed_key is not None and signed_key != request_key:
        raise Forbidden("signed service idempotency key does not match")
    signed_body = principal_field(principal, "body_sha256")
    if signed_body is not None:
        if body is None or signed_body != canonical_body_sha256(body):
            raise Forbidden("signed service body does not match")


def _provision_binding_registered(
    request: Request,
    principal: Any,
    *,
    enterprise_id: str,
    tenant_id: str,
) -> bool:
    registration = _registration_for(request, principal)
    if registration is None:
        return False
    capabilities = _as_strings(_field(registration, "provisioning_capabilities"))
    scopes = _as_strings(_field(registration, "scopes"))
    if _REQUIRED_CAPABILITIES["provision"] not in capabilities or _REQUIRED_SCOPES["provision"] not in scopes:
        raise Forbidden("service principal lacks the enterprise provisioning capability")
    # F01 is the sole capability allowed to establish the first binding.  Its
    # signed assertion carries the exact new IDs; a static target tuple is not
    # required and null/origin-only tuples are never treated as wildcards.
    return True


def test_compatibility_principal(
    request: Request,
    body: Any,
    *,
    operation: str,
    idempotency_key: str,
) -> Any | None:
    """Build a stable, explicitly TEST-only principal after legacy auth.

    TEST deployment uses the existing shared service token while the signed
    service trust manifest is provisioned separately.  The opt-in principal
    still carries the same target/path/body/key fields and is persisted as the
    exact binding; it is never available outside AITEAM_ENV=test.
    """
    settings = getattr(request.app.state, "settings", None)
    if not test_onboarding_writes_enabled(settings):
        return None
    if not getattr(settings, "service_token", None):
        raise Unauthorized("TEST onboarding service token is not configured")
    body_values = body.model_dump(mode="json", exclude_none=True) if hasattr(body, "model_dump") else dict(body)
    enterprise_id = body_values.get("enterprise_id") or body_values.get("org_id")
    tenant_id = body_values.get("tenant_id")
    scopes = {
        "provision": "enterprise:provision",
        "bootstrap": "owner:bootstrap",
        "notification": "notification:write",
    }
    capabilities = {
        "provision": "provision-enterprise",
        "bootstrap": "owner-bootstrap",
        "notification": "enterprise-notification",
    }
    return type("TestServicePrincipal", (), {
        "iss": "aiteam-test-service",
        "sub": "aiteam-test-service",
        "aud": getattr(settings, "service_name", None) or "aiteam-manager-service",
        "purpose": "service",
        "deployment_id": "aiteam-test-deployment",
        "enterprise_id": enterprise_id if operation != "bootstrap" else None,
        "tenant_id": tenant_id,
        "scope": (scopes[operation],),
        "origin": "https://aiteam-test.invalid",
        "capability": capabilities[operation],
        "kid": "aiteam-test-service",
        "path": request.url.path,
        "idempotency_key": idempotency_key,
        "body_sha256": canonical_body_sha256(body),
    })()


def validate_onboarding_principal(
    request: Request,
    principal: Any | None,
    *,
    operation: str,
    enterprise_id: str | None = None,
    tenant_id: str | None = None,
    body: Any | None = None,
    idempotency_key: str | None = None,
) -> ServiceTrustContext | None:
    """Apply operation-specific capability semantics after shared verification."""
    if principal is None:
        if getattr(request.app.state.settings, "aiteam_env", None) == "production":
            raise Unauthorized("verified signed service principal is required")
        return None
    _check_common_request_proof(
        request,
        principal,
        body=body,
        idempotency_key=idempotency_key,
        require_idempotency_key=True,
    )
    if principal_field(principal, "purpose") != "service":
        raise Forbidden("service principal purpose is not valid")
    scopes = _as_strings(principal_field(principal, "scope", "scopes"))
    if _REQUIRED_SCOPES[operation] not in scopes:
        raise Forbidden("service principal scope is not authorized for this operation")
    capability = principal_field(principal, "capability")
    if operation == "provision" and capability != _REQUIRED_CAPABILITIES[operation]:
        raise Forbidden("service principal capability is not authorized")
    if capability is not None and operation != "provision" and capability != _REQUIRED_CAPABILITIES[operation]:
        raise Forbidden("service principal capability is not authorized")
    for target in (enterprise_id, tenant_id, principal_field(principal, "enterprise_id"), principal_field(principal, "tenant_id")):
        if isinstance(target, str) and "*" in target:
            raise Forbidden("wildcard tenant targets are not allowed")
    registration = _registration_for(request, principal)
    if registration is not None and _REQUIRED_SCOPES[operation] not in _as_strings(_field(registration, "scopes")):
        raise Forbidden("service principal registration scope is not authorized")
    if operation == "provision":
        if (
            enterprise_id is None
            or tenant_id is None
            or principal_field(principal, "enterprise_id") != enterprise_id
            or principal_field(principal, "tenant_id") != tenant_id
        ):
            raise Forbidden("F01 target does not match the signed service principal")
        _provision_binding_registered(
            request,
            principal,
            enterprise_id=enterprise_id,
            tenant_id=tenant_id,
        )
    elif operation == "bootstrap":
        if principal_field(principal, "enterprise_id") is not None or principal_field(principal, "tenant_id") != tenant_id:
            raise Forbidden("owner bootstrap target does not match the signed service principal")
    elif operation == "notification":
        if (
            principal_field(principal, "enterprise_id") != enterprise_id
            or principal_field(principal, "tenant_id") != tenant_id
        ):
            raise Forbidden("notification target does not match the signed service principal")
    return ServiceTrustContext(principal=principal, registration=registration)


def service_tenant_context(request: Request) -> TenantContext:
    """Existing service-ingress helper; tenant still comes only from verified state."""
    principal = require_operator_service_principal(request)
    tenant_id = principal_field(principal, "tenant_id") if principal is not None else getattr(request.state, "service_tenant_id", None)
    if not tenant_id:
        raise Unauthorized("authenticated service tenant claim is required")
    return TenantContext(tenant_id=str(tenant_id), user_id="service", roles=["service"])


__all__ = [
    "ServiceTrustContext",
    "canonical_body_sha256",
    "principal_field",
    "require_operator_service_principal",
    "service_tenant_context",
    "validate_onboarding_principal",
]
