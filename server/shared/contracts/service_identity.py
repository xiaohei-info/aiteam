"""Typed claims for short-lived service-to-service assertions.

Service assertions are deliberately separate from user ``TokenClaims``.  A
service assertion proves the calling deployment, target audience, purpose and
bounded enterprise scope; it is not a user session and must never be accepted
by the user JWT verifier.
"""

from __future__ import annotations

from typing import Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field


class ServicePrincipal(BaseModel):
    """Verified service identity carried by an RS256 assertion.

    The wire names follow JWT conventions (``iss``, ``sub``, ``aud``, ...).
    Convenience properties below use the names used by the Python service
    layer without creating a second wire contract.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    iss: str = Field(validation_alias=AliasChoices("iss", "issuer"), serialization_alias="iss", min_length=1)
    sub: str = Field(validation_alias=AliasChoices("sub", "subject"), serialization_alias="sub", min_length=1)
    aud: str = Field(validation_alias=AliasChoices("aud", "audience"), serialization_alias="aud", min_length=1)
    purpose: Literal["service"]
    deployment_id: str = Field(min_length=1)
    enterprise_id: str | None = None
    tenant_id: str | None = None
    scope: tuple[str, ...] = Field(
        default_factory=tuple,
        validation_alias=AliasChoices("scope", "scopes"),
        serialization_alias="scope",
    )
    iat: int
    nbf: int
    exp: int
    jti: str = Field(min_length=1)
    path: str = Field(min_length=1)
    body_sha256: str | None = None
    origin: str | None = None
    capability: str | None = None
    idempotency_key: str | None = None
    kid: str = Field(min_length=1)

    @property
    def issuer(self) -> str:
        return self.iss

    @property
    def subject(self) -> str:
        return self.sub

    @property
    def audience(self) -> str:
        return self.aud

    @property
    def scopes(self) -> tuple[str, ...]:
        return self.scope

    @property
    def is_enterprise_scoped(self) -> bool:
        """Whether the assertion carries at least one enterprise boundary."""
        return bool(self.enterprise_id or self.tenant_id)


ServiceIdentityClaims = ServicePrincipal

__all__ = ["ServiceIdentityClaims", "ServicePrincipal"]
