-- Server-authoritative user authentication sessions.
-- JWT signature/expiry remains stateless proof; this table is the single online
-- decision for logout, password reset and other session revocation actions.

CREATE TABLE IF NOT EXISTS auth_session (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    jti           uuid NOT NULL UNIQUE,
    user_id       uuid NOT NULL,
    issued_at     timestamptz NOT NULL,
    expires_at    timestamptz NOT NULL,
    revoked_at    timestamptz,
    revoke_reason text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_auth_session_expiry CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS ix_auth_session_user_active
    ON auth_session (tenant_id, user_id, revoked_at, expires_at);

ALTER TABLE auth_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_session FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON auth_session;
CREATE POLICY tenant_isolation ON auth_session
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_session TO app_rw;
