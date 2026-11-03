from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from operation_service.auth_sessions import OperationAuthSessionRepository
from shared.auth.session import SessionAwareTokenVerifier
from shared.contracts.auth import TokenClaims


class StubVerifier:
    def __init__(self, claims: TokenClaims):
        self.claims = claims

    def verify(self, _token: str) -> TokenClaims:
        return self.claims


def test_session_authority_rejects_revoked_unexpired_jwt():
    store = OperationAuthSessionRepository()
    issued = datetime.now(UTC)
    expires = issued + timedelta(days=30)
    jti = store.create(user_id="u1", issued_at=issued, expires_at=expires)
    claims = TokenClaims(user_id="u1", roles=["system_admin"], exp=int(expires.timestamp()), jti=jti)
    verifier = SessionAwareTokenVerifier(StubVerifier(claims), store)

    assert verifier.verify("token").jti == jti
    store.revoke(claims, reason="user_logout")

    with pytest.raises(Exception, match="authentication session revoked"):
        verifier.verify("token")


def test_session_authority_rejects_unknown_session_id():
    store = OperationAuthSessionRepository()
    issued = datetime.now(UTC)
    claims = TokenClaims(
        user_id="u1",
        roles=["system_admin"],
        exp=int((issued + timedelta(days=30)).timestamp()),
        jti="00000000-0000-4000-8000-000000000001",
    )

    with pytest.raises(Exception, match="authentication session revoked"):
        SessionAwareTokenVerifier(StubVerifier(claims), store).verify("token")
