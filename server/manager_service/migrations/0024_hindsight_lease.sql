-- Manager-owned opaque Hindsight facade lease registry.
--
-- Raw lease tokens never cross this schema boundary.  The token_sha256 digest
-- is sufficient for bearer lookup; tenant/member/employee/snapshot/policy and
-- derived bank metadata stay bound to the same lease row.
--
-- Tenant writes use app_rw + SET LOCAL app.tenant_id through PgTenantRouter.
-- The unauthenticated facade performs only a narrow hash lookup through the
-- management DSN, then checks active status and the requested bank in Python.

CREATE TABLE IF NOT EXISTS hindsight_lease (
    lease_id           text PRIMARY KEY,
    token_sha256       text NOT NULL,
    tenant_id          uuid NOT NULL,
    member_id          uuid NOT NULL,
    employee_id        uuid NOT NULL,
    snapshot_version   text NOT NULL,
    policy_fingerprint text NOT NULL,
    bank_id            text NOT NULL,
    version            integer NOT NULL,
    issued_at          timestamptz NOT NULL,
    expires_at         timestamptz NOT NULL,
    revoked_at         timestamptz,
    CONSTRAINT uq_hindsight_lease_token_sha256 UNIQUE (token_sha256),
    CONSTRAINT chk_hindsight_lease_token_sha256
        CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_hindsight_lease_policy_fingerprint
        CHECK (policy_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_hindsight_lease_version CHECK (version > 0),
    CONSTRAINT chk_hindsight_lease_times CHECK (expires_at > issued_at),
    CONSTRAINT chk_hindsight_lease_bank CHECK (bank_id <> '')
);

-- Expired rows are terminalized by startup cleanup or the next scoped write;
-- only non-revoked rows participate in active-scope uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hindsight_lease_active_scope
    ON hindsight_lease (tenant_id, member_id, employee_id)
    WHERE revoked_at IS NULL;

ALTER TABLE hindsight_lease ENABLE ROW LEVEL SECURITY;
ALTER TABLE hindsight_lease FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hindsight_lease;
CREATE POLICY tenant_isolation ON hindsight_lease
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON hindsight_lease TO app_rw;
