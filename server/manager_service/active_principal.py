"""Manager online authorization, after shared/local JWT signature verification.

Agent offline verification is deliberately unchanged: it only knows JWT expiry.
Manager uses its own account truth for status and current roles, including admins.
"""
from shared.auth import TokenVerifier, tenant_context_from
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden, Unauthorized


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


class ActivePrincipalVerifier(TokenVerifier):
    """Manager-only verifier decorator; never queries any upstream identity service."""

    def __init__(self, verifier: TokenVerifier, repository):
        self._verifier = verifier
        self._repository = repository

    def verify(self, token: str):
        claims = self._verifier.verify(token)
        principal = require_active(self._repository.find_user(tenant_context_from(claims), user_id=claims.user_id))
        return claims.model_copy(update={"roles": list(principal.roles)})
