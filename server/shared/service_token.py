"""Service-to-service authentication boundary.

Production service calls use a fresh short-lived RS256 service assertion in the
``Authorization: Bearer`` header.  The assertion is verified against an
explicit local trust registration and is bound to the request path/body,
route scope, audience and enterprise/tenant target.

The old shared ``SERVICE_TOKEN`` behavior remains only as an explicit
non-production compatibility path.  It is never accepted in ``production``;
a forgeable ``X-Service-Identity`` label is never an authentication factor.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any

from fastapi import Request

from shared.contracts.service_identity import ServicePrincipal
from shared.errors import Forbidden, Unauthorized
from shared.service_identity import (
    ServiceIdentitySigner,
    ServiceIdentityVerifier,
    TrustedServiceKey,
    request_target,
)

logger = logging.getLogger(__name__)
_VERIFIER_LOCK = threading.Lock()

_DEV_TOKEN_PLACEHOLDER = "dev-service-token-placeholder"

# The map is deliberately kept in the shared boundary so Manager and Operation
# routes cannot silently choose different purpose/scope semantics.
_ROUTE_POLICIES: tuple[tuple[str, str], ...] = (
    ("/api/manager/tenants", "enterprise:provision"),
    ("/api/manager/owner-bootstrap", "owner:bootstrap"),
    ("/api/manager/enterprise/notify", "notification:write"),
    ("/api/manager/catalog/notify", "catalog:notify"),
    ("/api/operation/rollups", "rollup:write"),
    ("/api/operation/provider-access/resolve", "relay:resolve"),
)

_SERVICE_CAPABILITY_POLICIES: dict[str, str] = {
    "/api/manager/tenants": "provision-enterprise",
}

_TARGET_BINDING_POLICIES: dict[str, tuple[str, bool]] = {
    "/api/manager/tenants": ("provision-enterprise", False),
    # The frozen OwnerBootstrapSync DTO is tenant_id-only.  An enterprise
    # claim is deliberately rejected rather than guessed from the body.
    "/api/manager/owner-bootstrap": ("tenant-only", True),
    "/api/manager/enterprise/notify": ("enterprise-tenant", False),
    "/api/operation/rollups": ("enterprise-tenant", False),
    "/api/operation/provider-access/resolve": ("tenant-only", True),
    "/api/operation/catalog/platform-providers": ("tenant-only", True),
    # Enterprise-policy consumers must carry the exact enterprise/tenant target;
    # signed scope alone is not a binding and must never authorize an arbitrary
    # policy row.
    "/api/operation/enterprise-policy": ("enterprise-tenant", False),
    "/api/manager/enterprise-policy": ("enterprise-tenant", False),
}


def required_service_scope(path: str) -> str | None:
    """Return the least scope required by a known service endpoint."""

    for prefix, scope in _ROUTE_POLICIES:
        if path == prefix:
            return scope
    if path.startswith("/api/operation/catalog/pull/") or path == "/api/operation/catalog/platform-providers":
        return "catalog:read"
    if path.startswith("/api/operation/skill-market/pull/"):
        return "catalog:read"
    if path.startswith("/api/operation/enterprise-policy"):
        return "enterprise-policy:read"
    if path.startswith("/api/manager/enterprise-policy"):
        return "enterprise-policy:write"
    return None


def service_required_capability(path: str) -> str | None:
    return _SERVICE_CAPABILITY_POLICIES.get(path)


def service_target_binding_policy(path: str) -> tuple[str | None, bool]:
    """Return (binding kind, reject enterprise claim) for a service route."""

    for prefix, policy in _TARGET_BINDING_POLICIES.items():
        if path == prefix or path.startswith(prefix + "/"):
            return policy
    return None, False


def _extract_service_token(request: Request) -> str | None:
    """Read the legacy compatibility token, preferring X-Service-Token."""

    direct = request.headers.get("X-Service-Token")
    if direct:
        return direct.strip()
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[len("Bearer "):].strip()
    return None


def _extract_bearer(request: Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        value = auth[len("Bearer "):].strip()
        return value or None
    return None


def _environment(settings: Any) -> str:
    return str(getattr(settings, "aiteam_env", None) or os.getenv("AITEAM_ENV", "development"))


def _service_mode(settings: Any) -> str:
    return str(
        getattr(settings, "service_auth_mode", None)
        or os.getenv("SERVICE_AUTH_MODE", "auto")
    ).strip().lower()


def _service_identity_verifier(request: Request, settings: Any) -> ServiceIdentityVerifier | None:
    configured = getattr(request.app.state, "service_identity_verifier", None)
    if configured is None:
        configured = getattr(request.app.state, "_service_identity_verifier", None)
    if configured is not None:
        if not isinstance(configured, ServiceIdentityVerifier):
            raise Unauthorized("service identity verifier is invalid")
        return configured
    try:
        # Initialization is locked so concurrent first requests cannot create
        # separate replay caches and lose the first assertion atomically.
        with _VERIFIER_LOCK:
            configured = getattr(request.app.state, "_service_identity_verifier", None)
            if configured is not None:
                if not isinstance(configured, ServiceIdentityVerifier):
                    raise Unauthorized("service identity verifier is invalid")
                return configured
            verifier = ServiceIdentityVerifier.from_settings(settings)
            if verifier is not None:
                request.app.state._service_identity_verifier = verifier
            return verifier
    except (TypeError, ValueError) as exc:
        logger.warning("service identity trust configuration is invalid", exc_info=True)
        raise Unauthorized("service identity trust configuration is invalid") from exc


def _request_body(request: Request) -> bytes | None:
    """Read FastAPI's already-cached body without making a sync dependency async."""

    body = getattr(request, "_body", None)
    if body is None:
        return None
    return bytes(body)


def _json_target(body: bytes | None, request: Request) -> tuple[str | None, str | None]:
    """Extract target IDs only for binding; the body remains a route DTO authority."""

    values: dict[str, Any] = {}
    if body:
        try:
            parsed = json.loads(body)
        except (TypeError, ValueError):
            parsed = None
        if isinstance(parsed, dict):
            values = parsed
    tenant_id = values.get("tenant_id")
    enterprise_id = values.get("enterprise_id") or values.get("org_id")
    if tenant_id is None:
        tenant_id = request.query_params.get("tenant_id")
    for name, value in (("enterprise", enterprise_id), ("tenant", tenant_id)):
        if value is not None and (not isinstance(value, str) or not value.strip() or "*" in value):
            raise Unauthorized(f"invalid service {name} target")
    return (
        enterprise_id.strip() if isinstance(enterprise_id, str) and enterprise_id.strip() else None,
        tenant_id.strip() if isinstance(tenant_id, str) and tenant_id.strip() else None,
    )


def _verify_signed(request: Request, verifier: ServiceIdentityVerifier) -> ServicePrincipal:
    settings = getattr(request.app.state, "settings", None)
    if settings is None:
        raise Unauthorized("service identity settings are unavailable")
    bearer = _extract_bearer(request)
    if not bearer:
        raise Unauthorized("signed service identity is required")
    body = _request_body(request)
    path = request_target(request.url.path, request.url.query)
    body_enterprise_id, body_tenant_id = _json_target(body, request)
    required_scope = required_service_scope(request.url.path)
    target_binding, reject_enterprise_scope = service_target_binding_policy(request.url.path)
    required_capability = service_required_capability(request.url.path)
    principal = verifier.verify(
        bearer,
        path=path,
        body=body,
        required_scope=required_scope,
        required_enterprise_id=body_enterprise_id,
        required_tenant_id=body_tenant_id,
        require_enterprise_scope=body_enterprise_id is not None,
        reject_enterprise_scope=reject_enterprise_scope,
        target_binding=target_binding,
        required_capability=required_capability,
        expected_origin=getattr(settings, "service_identity_origin", None),
        expected_idempotency_key=request.headers.get("Idempotency-Key"),
        audience=getattr(settings, "service_identity_audience", None) or getattr(settings, "service_name", None),
    )
    # Body/query target IDs are checked against the verified principal.  This
    # is intentionally a 403: the assertion is authentic but not authorized
    # for the requested enterprise/tenant.
    if body_tenant_id and principal.tenant_id != body_tenant_id:
        raise Forbidden("service tenant scope does not match target")
    if body_enterprise_id and principal.enterprise_id != body_enterprise_id:
        raise Forbidden("service enterprise scope does not match target")
    if required_scope is not None and required_scope not in principal.scopes:
        raise Forbidden("service identity scope is not authorized")

    request.state.service_principal = principal
    request.state.service_tenant_id = principal.tenant_id
    request.state.service_enterprise_id = principal.enterprise_id
    request.state.service_scopes = principal.scopes
    return principal


def _legacy_verify(request: Request, settings: Any, *, environment: str) -> None:
    """Compatibility verifier for explicit dev/test paths only."""

    if environment == "production":
        raise Unauthorized("signed service identity is required in production")
    expected = getattr(settings, "service_token", None)
    if not expected:
        raise Unauthorized("SERVICE_TOKEN is not configured. Service-to-service authentication is required.")
    is_dev_placeholder = expected == _DEV_TOKEN_PLACEHOLDER
    if is_dev_placeholder and environment not in {"dev", "development"}:
        raise Unauthorized("SERVICE_TOKEN development placeholder is not allowed for this environment")
    if is_dev_placeholder and environment in {"dev", "development"}:
        # Preserve the historical explicit dev placeholder behavior, but do not
        # let a forgeable identity label turn into an authentication factor.
        if request.headers.get("X-Service-Identity") and not _extract_service_token(request):
            raise Unauthorized("signed service identity or service token is required")
        provided = _extract_service_token(request)
        if provided and provided != expected:
            raise Unauthorized("invalid service token")
        logger.warning(
            "SERVICE_TOKEN 使用 dev 占位值；服务间调用未进行真实签名校验。"
            "生产环境必须配置短期 signed service identity。"
        )
        return
    provided = _extract_service_token(request)
    if not provided or provided != expected:
        raise Unauthorized("invalid service token")


def verify_service_token(request: Request) -> ServicePrincipal | None:
    """FastAPI dependency for the service trust boundary.

    Signed assertions are always preferred when a verifier is configured.  A
    token/header failure never falls through to the legacy shared token.  The
    latter exists only for explicit development/test compatibility and is
    unconditionally disabled in production.
    """

    settings = getattr(request.app.state, "settings", None)
    if settings is None:
        raise Unauthorized("service identity settings are unavailable")
    environment = _environment(settings)
    mode = _service_mode(settings)
    if mode not in {"auto", "signed", "legacy"}:
        raise Unauthorized("invalid service authentication mode")

    verifier = _service_identity_verifier(request, settings)
    bearer = _extract_bearer(request)
    has_signed_configuration = verifier is not None
    if mode == "legacy" and environment != "production":
        _legacy_verify(request, settings, environment=environment)
        return
    if mode == "signed" or environment == "production" or has_signed_configuration:
        if verifier is None:
            raise Unauthorized("signed service identity trust is not configured")
        return _verify_signed(request, verifier)

    # A JWT-shaped Authorization value is never interpreted as a legacy shared
    # token in compatibility mode; this prevents a user token from crossing the
    # service boundary by accident.
    if bearer and bearer.count(".") == 2 and not request.headers.get("X-Service-Token"):
        raise Unauthorized("signed service identity trust is not configured")
    if mode == "legacy" or mode == "auto":
        _legacy_verify(request, settings, environment=environment)
        return
    raise Unauthorized("signed service identity is required")


# Descriptive alias for callers migrating off the historical name.
verify_service_identity = verify_service_token


__all__ = [
    "ServiceIdentitySigner",
    "ServiceIdentityVerifier",
    "TrustedServiceKey",
    "required_service_scope",
    "service_required_capability",
    "service_target_binding_policy",
    "verify_service_identity",
    "verify_service_token",
]
