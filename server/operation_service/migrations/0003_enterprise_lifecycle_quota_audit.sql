-- Operation enterprise lifecycle + quota + audit events (issue #413)
--
-- Mirrors PR #353 semantics that were implemented for the frozen app/,
-- but re-implemented here for the new Operation service with dedicated tables.
-- The frozen app/ is NEVER touched.
--
-- Idempotent: repeatable execution (IF NOT EXISTS / CREATE OR REPLACE / DROP+ADD).
--
-- Ownership (CLAUDE/AGENTS S3.2): enterprise_account, operation_enterprise_quota and
--   operation_audit_event are all single-writer: Operator only.
--   quota: holds operation-side declared caps only; no direct Agent consumption.
--   audit: operation-side metadata only; no password / token / session content / raw event.
--
-- app_rw role is created in 0001; we only GRANT here.

-- ---- 1. enterprise_account: lifecycle status columns ----
ALTER TABLE enterprise_account
    ADD COLUMN IF NOT EXISTS operation_status text NOT NULL DEFAULT 'active';

-- Widen/sanitize: map legacy 'normal'/'archived'/'banned' to the new enum values
-- active/suspended/banned so existing rows do not violate the upcoming CHECK constraint.
UPDATE enterprise_account
SET operation_status = CASE operation_status
    WHEN 'banned'     THEN 'banned'
    WHEN 'archived'   THEN 'suspended'
    WHEN 'normal'     THEN 'active'
    ELSE 'active'
END
WHERE operation_status IS NULL
   OR operation_status NOT IN ('active','suspended','banned','closed');

-- CHECK constraint (drop then add so reruns stay idempotent).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'enterprise_account'::regclass
          AND conname = 'ck_enterprise_account_operation_status'
    ) THEN
        ALTER TABLE enterprise_account DROP CONSTRAINT ck_enterprise_account_operation_status;
    END IF;
    ALTER TABLE enterprise_account
        ADD CONSTRAINT ck_enterprise_account_operation_status
        CHECK (operation_status IN ('active','suspended','banned','closed'));
END
$$;

ALTER TABLE enterprise_account
    ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
    ADD COLUMN IF NOT EXISTS suspended_reason text,
    ADD COLUMN IF NOT EXISTS banned_at timestamptz,
    ADD COLUMN IF NOT EXISTS banned_reason text,
    ADD COLUMN IF NOT EXISTS closed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_enterprise_account_operation_status
    ON enterprise_account (operation_status);


-- ---- 2. operation_enterprise_quota: per-enterprise quota ----
CREATE TABLE IF NOT EXISTS operation_enterprise_quota (
    enterprise_id        uuid PRIMARY KEY REFERENCES enterprise_account(enterprise_id),
    employee_limit       integer NOT NULL DEFAULT -1,
    employee_used        integer NOT NULL DEFAULT 0,
    storage_limit_mb     integer NOT NULL DEFAULT -1,
    storage_used_mb      integer NOT NULL DEFAULT 0,
    api_rate_limit       integer NOT NULL DEFAULT -1,
    api_rate_used        integer NOT NULL DEFAULT 0,
    token_quota_limit    integer NOT NULL DEFAULT -1,
    token_quota_used     integer NOT NULL DEFAULT 0,
    updated_at           timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'operation_enterprise_quota'::regclass
          AND conname = 'ck_quota_not_negative'
    ) THEN
        ALTER TABLE operation_enterprise_quota DROP CONSTRAINT ck_quota_not_negative;
    END IF;
    ALTER TABLE operation_enterprise_quota
        ADD CONSTRAINT ck_quota_not_negative
        CHECK (
            employee_used >= 0 AND storage_used_mb >= 0
            AND api_rate_used >= 0 AND token_quota_used >= 0
            AND employee_limit >= -1 AND storage_limit_mb >= -1
            AND api_rate_limit >= -1 AND token_quota_limit >= -1
        );
END
$$;

COMMENT ON TABLE operation_enterprise_quota IS 'Operation-side enterprise quota (issue #413); dimensions employee/storage_mb/api_rate per minute/token_month; limit=-1 = unlimited';
COMMENT ON COLUMN operation_enterprise_quota.employee_limit IS 'Employee headcount cap; -1 = unlimited';
COMMENT ON COLUMN operation_enterprise_quota.token_quota_limit IS 'Token monthly quota (yuan); -1 = unlimited';

GRANT SELECT, INSERT, UPDATE, DELETE ON operation_enterprise_quota TO app_rw;


-- ---- 3. operation_audit_event: enriched audit events ----
CREATE TABLE IF NOT EXISTS operation_audit_event (
    event_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id   uuid NOT NULL REFERENCES enterprise_account(enterprise_id),
    actor_id        text,
    actor_name      text,
    action          text NOT NULL,
    detail          text NOT NULL DEFAULT '',
    severity        text NOT NULL DEFAULT 'info',
    result          text NOT NULL DEFAULT 'success',
    ip_address      inet,
    user_agent      text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_event_enterprise
    ON operation_audit_event (enterprise_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event_action
    ON operation_audit_event (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event_severity
    ON operation_audit_event (severity, created_at DESC);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'operation_audit_event'::regclass
          AND conname = 'ck_audit_event_severity'
    ) THEN
        ALTER TABLE operation_audit_event DROP CONSTRAINT ck_audit_event_severity;
    END IF;
    ALTER TABLE operation_audit_event
        ADD CONSTRAINT ck_audit_event_severity
        CHECK (severity IN ('info','warning','critical'));

    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'operation_audit_event'::regclass
          AND conname = 'ck_audit_event_result'
    ) THEN
        ALTER TABLE operation_audit_event DROP CONSTRAINT ck_audit_event_result;
    END IF;
    ALTER TABLE operation_audit_event
        ADD CONSTRAINT ck_audit_event_result
        CHECK (result IN ('success','failure'));
END
$$;

COMMENT ON TABLE operation_audit_event IS 'Operation-side audit events (issue #413); operation-side metadata only; no password / token / session content';
COMMENT ON COLUMN operation_audit_event.severity IS 'info|warning|critical';
COMMENT ON COLUMN operation_audit_event.result IS 'success|failure';

GRANT SELECT, INSERT, UPDATE, DELETE ON operation_audit_event TO app_rw;
