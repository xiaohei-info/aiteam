-- Server-authoritative Operation login sessions.
-- The Operation database is single-tenant; no RLS is needed here.

CREATE TABLE IF NOT EXISTS operation_auth_session (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    jti           uuid NOT NULL UNIQUE,
    user_id       text NOT NULL,
    issued_at     timestamptz NOT NULL,
    expires_at    timestamptz NOT NULL,
    revoked_at    timestamptz,
    revoke_reason text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_operation_auth_session_expiry CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS ix_operation_auth_session_user_active
    ON operation_auth_session (user_id, revoked_at, expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON operation_auth_session TO app_rw;
