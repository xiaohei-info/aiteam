-- Metadata only. Hindsight remains the sole memory body store.
CREATE TABLE IF NOT EXISTS memory_acceptance (
    tenant_id uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    employee_id uuid NOT NULL,
    member_id uuid NOT NULL,
    bank_id text NOT NULL,
    document_id text NOT NULL,
    operation_id uuid NOT NULL,
    policy_revision bigint NOT NULL,
    accepted_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    operation_state text NOT NULL DEFAULT 'pending' CHECK(operation_state IN ('pending','processing','completed','failed','cancelled','unknown')),
    terminal_at timestamptz,
    cleanup_state text NOT NULL DEFAULT 'waiting' CHECK(cleanup_state IN ('waiting','invalidating','cleaned')),
    claim_owner text,
    claim_until timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt timestamptz NOT NULL DEFAULT now(),
    last_error_code text,
    PRIMARY KEY (tenant_id, bank_id, document_id)
);
ALTER TABLE memory_acceptance ADD COLUMN IF NOT EXISTS last_batch_sha256 text;
-- Jobs survive employee/member deletion so already accepted finite data can still be invalidated.
CREATE INDEX IF NOT EXISTS memory_acceptance_due ON memory_acceptance(tenant_id,next_attempt) WHERE cleanup_state <> 'cleaned';
ALTER TABLE memory_acceptance ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_acceptance FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON memory_acceptance;
CREATE POLICY tenant_isolation ON memory_acceptance
USING(tenant_id=current_setting('app.tenant_id',true)::uuid)
WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT,UPDATE ON memory_acceptance TO app_rw;

CREATE TABLE IF NOT EXISTS memory_bank_guard (
    tenant_id uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    employee_id uuid NOT NULL,
    bank_id text NOT NULL,
    guarded_at timestamptz NOT NULL DEFAULT now(),
    source text NOT NULL,
    PRIMARY KEY (tenant_id,bank_id)
);
ALTER TABLE memory_bank_guard ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_bank_guard FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON memory_bank_guard;
CREATE POLICY tenant_isolation ON memory_bank_guard
USING(tenant_id=current_setting('app.tenant_id',true)::uuid)
WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON memory_bank_guard TO app_rw;
-- Observed effective finite settings, not catalog templates or guessed missing intent.
INSERT INTO memory_bank_guard(tenant_id,employee_id,bank_id,source)
SELECT tenant_id,employee_id,'aiteam-'||substring(encode(sha256(convert_to(tenant_id::text||':'||employee_id::text,'UTF8')),'hex') for 32),'legacy_finite_setting'
FROM employee_memory_setting WHERE retention_days IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO memory_bank_guard(tenant_id,employee_id,bank_id,source)
SELECT DISTINCT l.tenant_id,l.employee_id,l.bank_id,'legacy_finite_lease_bank'
FROM hindsight_lease l JOIN employee_memory_setting s USING(tenant_id,employee_id)
WHERE s.retention_days IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO memory_bank_guard(tenant_id,employee_id,bank_id,source)
SELECT DISTINCT tenant_id,employee_id,bank_id,'manager_acceptance'
FROM memory_acceptance WHERE expires_at IS NOT NULL
ON CONFLICT DO NOTHING;
