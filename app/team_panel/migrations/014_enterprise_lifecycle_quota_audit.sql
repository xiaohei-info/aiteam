-- 014: Enterprise lifecycle + quota + audit enrichment (GitHub #291 / AITEAM-246)
-- Extends enterprise status to full state machine (active|suspended|banned|closed),
-- adds enterprise_quota table, and enriches audit_event with severity/result/ip/ua.

-- ── Enterprise status: widen CHECK to include banned/closed ─────────────────
DO $$
DECLARE
    cname TEXT;
BEGIN
    -- Drop any existing status CHECK constraint regardless of its name
    -- (inline CHECKs in 001 are auto-named, e.g. enterprise_status_check or
    -- enterprise_status_check1). We resolve it from pg_constraint.
    SELECT conname INTO cname
    FROM pg_constraint
    WHERE conrelid = 'enterprise'::regclass
      AND contype = 'c'
      AND conname LIKE '%status%check';
    IF cname IS NOT NULL THEN
        EXECUTE 'ALTER TABLE enterprise DROP CONSTRAINT ' || quote_ident(cname);
    END IF;
END $$;
ALTER TABLE enterprise ADD CONSTRAINT enterprise_status_check
    CHECK(status IN ('active','suspended','banned','closed'));

-- Migrate any legacy 'archived' rows to 'closed' (terminal state).
UPDATE enterprise SET status = 'closed' WHERE status = 'archived';

-- ── Enterprise quota ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS enterprise_quota (
    enterprise_id TEXT PRIMARY KEY REFERENCES enterprise(id) ON DELETE CASCADE,
    employee_quota INTEGER NOT NULL DEFAULT 50,
    storage_quota_mb INTEGER NOT NULL DEFAULT 1024,
    api_rate_limit INTEGER NOT NULL DEFAULT 100,
    token_quota BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_enterprise_quota_enterprise ON enterprise_quota(enterprise_id);

-- ── Audit event enrichment ───────────────────────────────────────────────────
ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'info';
ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS result TEXT NOT NULL DEFAULT 'success';
ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS ip_address TEXT;
ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS user_agent TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_severity ON audit_event(severity);
CREATE INDEX IF NOT EXISTS idx_audit_result ON audit_event(result);
