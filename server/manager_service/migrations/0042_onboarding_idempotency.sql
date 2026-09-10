-- Durable tenant-scoped receipts for Manager F02/F17 control-plane writes.
-- Only fingerprints and safe response objects are retained; no bootstrap secret
-- or notification request body is stored.

CREATE TABLE IF NOT EXISTS manager_idempotency_receipt (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    operation           text NOT NULL,
    idempotency_key     text NOT NULL,
    request_fingerprint text NOT NULL,
    state               text NOT NULL DEFAULT 'pending',
    response_body       jsonb,
    status_code         integer NOT NULL DEFAULT 200,
    created_at          timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz,
    CONSTRAINT uq_manager_idempotency_key
        UNIQUE (tenant_id, operation, idempotency_key),
    CONSTRAINT ck_manager_idempotency_state
        CHECK (state IN ('pending', 'completed'))
);

CREATE INDEX IF NOT EXISTS ix_manager_idempotency_tenant_created
    ON manager_idempotency_receipt (tenant_id, created_at DESC);

ALTER TABLE manager_idempotency_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE manager_idempotency_receipt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON manager_idempotency_receipt;
CREATE POLICY tenant_isolation ON manager_idempotency_receipt
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON manager_idempotency_receipt TO app_rw;

-- F01 is called before a tenant context exists, so its receipt is keyed by the
-- signed operation rather than by the tenant-scoped F02/F17 table above.  The
-- row and tenant registry mutation are committed by the same admin connection;
-- a retry with another fingerprint cannot create a second tenant.
CREATE TABLE IF NOT EXISTS manager_onboarding_receipt (
    idempotency_key     text PRIMARY KEY,
    request_fingerprint text NOT NULL,
    tenant_id           uuid NOT NULL,
    enterprise_id       uuid NOT NULL,
    enterprise_slug     text NOT NULL,
    enterprise_code     text,
    created_at          timestamptz NOT NULL DEFAULT now()
);
-- F01 accesses this table only through the admin connection; business app_rw
-- must not receive a second write path around the tenant-scoped API.
