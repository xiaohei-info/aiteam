from __future__ import annotations

from datetime import UTC, datetime

from shared.contracts.auth import TokenClaims


def operation_test_token(auth, *, user_id: str, role: str) -> str:
    """Issue a test token through the same in-memory session authority as the app."""
    issued_at = datetime.now(UTC)
    expires_at = datetime.fromtimestamp(9_999_999_999, UTC)
    jti = auth.sessions.create(user_id=user_id, issued_at=issued_at, expires_at=expires_at)
    claims = TokenClaims(
        user_id=user_id,
        roles=[role],
        iat=int(issued_at.timestamp()),
        exp=int(expires_at.timestamp()),
        jti=jti,
    )
    return auth.signer.sign(claims)
