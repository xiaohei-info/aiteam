"""Server-side authentication session enforcement.

JWT signature and expiry prove that a token was issued by a trusted signer.  The
session authority adds the revocation decision so logout, password changes and
account administration can invalidate an otherwise unexpired token.
"""

from __future__ import annotations

from typing import Protocol

from shared.contracts.auth import TokenClaims
from shared.errors import Unauthorized

from . import TokenVerifier


class SessionAuthority(Protocol):
    """The one server-side session decision used by protected entry points."""

    def is_active(self, claims: TokenClaims) -> bool:
        ...


class SessionAwareTokenVerifier(TokenVerifier):
    """Decorate signature verification with the authoritative session check."""

    def __init__(self, verifier: TokenVerifier, authority: SessionAuthority):
        self._verifier = verifier
        self._authority = authority

    def verify(self, token: str) -> TokenClaims:
        claims = self._verifier.verify(token)
        if not claims.jti or not self._authority.is_active(claims):
            raise Unauthorized("authentication session revoked")
        return claims
