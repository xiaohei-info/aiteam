"""Manager online authorization, after shared/local JWT signature verification.

Agent offline verification is deliberately unchanged: it only knows JWT expiry.
Manager uses its own account truth for status and current roles, including admins.
"""
from shared.auth import TokenVerifier, tenant_context_from
from shared.contracts.tenancy import TenantContext
from shared.errors import AppError, Forbidden, Unauthorized


class ManagerBindingRequired(AppError):
    status, code, title = 503, "manager_binding_required", "Manager Binding Required"


class ManagerBindingMismatch(AppError):
    status, code, title = 503, "manager_binding_mismatch", "Manager Binding Mismatch"


class PrincipalInactive(Forbidden):
    code = "principal_inactive"
    title = "Principal Inactive"


def require_active(principal):
    if principal is None:
        raise Unauthorized("account no longer exists")
    if principal.status != "active":
        raise PrincipalInactive("account is not active")
    return principal


def require_admin(ctx: TenantContext) -> None:
    if not set(ctx.roles) & {"owner", "enterprise_admin"}:
        raise Forbidden("requires owner or enterprise_admin")


def require_bound_tenant(
    deployment_tenant_id: str | None,
    requested_tenant_id: str | None = None,
) -> str:
    """Return the configured deployment tenant, never infer it from database rows."""
    if not deployment_tenant_id:
        raise ManagerBindingRequired("Manager deployment tenant binding is required")
    if requested_tenant_id is not None and str(requested_tenant_id) != str(deployment_tenant_id):
        raise ManagerBindingMismatch("Manager deployment tenant binding does not match the request")
    return str(deployment_tenant_id)


class ActivePrincipalVerifier(TokenVerifier):
    """Manager-only verifier decorator; never queries any upstream identity service."""

    def __init__(
        self,
        verifier: TokenVerifier,
        repository,
        *,
        deployment_tenant_id: str | None = None,
        require_binding: bool = False,
    ):
        self._verifier = verifier
        self._repository = repository
        self._deployment_tenant_id = deployment_tenant_id
        self._require_binding = require_binding

    def verify(self, token: str):
        claims = self._verifier.verify(token)
        if self._require_binding:
            require_bound_tenant(self._deployment_tenant_id, claims.tenant_id)
        elif self._deployment_tenant_id is not None and claims.tenant_id != self._deployment_tenant_id:
            raise ManagerBindingMismatch("Manager deployment tenant binding does not match the request")
        principal = require_active(self._repository.find_user(tenant_context_from(claims), user_id=claims.user_id))
        return claims.model_copy(update={"roles": list(principal.roles)})
