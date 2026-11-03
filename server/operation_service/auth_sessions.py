"""Operation-owned authentication session state."""

from __future__ import annotations

from datetime import UTC, datetime
from threading import Lock
from uuid import uuid4

from shared.contracts.auth import TokenClaims


class OperationAuthSessionRepository:
    """Durable in production; in-memory only for no-DB contract tests."""

    def __init__(self, dsn: str | None = None):
        self._dsn = dsn
        self._lock = Lock()
        self._sessions: dict[str, dict[str, object]] = {}

    def create(self, *, user_id: str, issued_at: datetime, expires_at: datetime) -> str:
        jti = str(uuid4())
        if self._dsn:
            import psycopg

            with psycopg.connect(self._dsn, autocommit=True) as conn:
                conn.execute(
                    "INSERT INTO operation_auth_session (jti, user_id, issued_at, expires_at) "
                    "VALUES (%s, %s, %s, %s)",
                    (jti, user_id, issued_at, expires_at),
                )
        else:
            with self._lock:
                self._sessions[jti] = {
                    "user_id": user_id,
                    "expires_at": expires_at,
                    "revoked_at": None,
                }
        return jti

    def is_active(self, claims: TokenClaims) -> bool:
        if not claims.jti:
            return False
        if self._dsn:
            import psycopg

            with psycopg.connect(self._dsn, autocommit=True) as conn:
                row = conn.execute(
                    "SELECT user_id, expires_at, revoked_at FROM operation_auth_session WHERE jti = %s",
                    (claims.jti,),
                ).fetchone()
        else:
            with self._lock:
                row_data = self._sessions.get(claims.jti)
            if row_data is None:
                return False
            row = (row_data["user_id"], row_data["expires_at"], row_data["revoked_at"])
        if row is None or str(row[0]) != claims.user_id or row[2] is not None:
            return False
        expires_at = row[1]
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)
        return expires_at > datetime.now(UTC)

    def revoke(self, claims: TokenClaims, *, reason: str) -> None:
        if not claims.jti:
            return
        if self._dsn:
            import psycopg

            with psycopg.connect(self._dsn, autocommit=True) as conn:
                conn.execute(
                    "UPDATE operation_auth_session SET revoked_at = COALESCE(revoked_at, now()), "
                    "revoke_reason = COALESCE(revoke_reason, %s) "
                    "WHERE jti = %s AND user_id = %s",
                    (reason, claims.jti, claims.user_id),
                )
        else:
            with self._lock:
                session = self._sessions.get(claims.jti)
                if session is not None:
                    session["revoked_at"] = datetime.now(UTC)

    def revoke_user(self, *, user_id: str, reason: str) -> None:
        if self._dsn:
            import psycopg

            with psycopg.connect(self._dsn, autocommit=True) as conn:
                conn.execute(
                    "UPDATE operation_auth_session SET revoked_at = COALESCE(revoked_at, now()), "
                    "revoke_reason = COALESCE(revoke_reason, %s) "
                    "WHERE user_id = %s AND revoked_at IS NULL",
                    (reason, user_id),
                )
        else:
            with self._lock:
                for session in self._sessions.values():
                    if session["user_id"] == user_id and session["revoked_at"] is None:
                        session["revoked_at"] = datetime.now(UTC)
