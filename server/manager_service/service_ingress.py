"""Authenticated service-ingress claims for Manager.

The shared development service-token guard authenticates the caller but does not
carry a tenant claim.  Tenant-scoped ingestion therefore fails closed unless the
upstream service-auth middleware has populated ``request.state.service_tenant_id``.
The request body is never a tenant authority.
"""

from __future__ import annotations

from fastapi import Request

from shared.contracts.tenancy import TenantContext
from shared.errors import Unauthorized
from shared.service_token import verify_service_token


def service_tenant_context(request: Request) -> TenantContext:
    verify_service_token(request)
    tenant_id = getattr(request.state, "service_tenant_id", None)
    if not tenant_id:
        raise Unauthorized("authenticated service tenant claim is required")
    return TenantContext(tenant_id=str(tenant_id), user_id="service", roles=["service"])
