-- Manager usage attribution and durable Manager -> Operator delivery (F13).
--
-- This migration keeps the existing aggregate table as the sole Manager usage
-- ledger.  The delivery table is an outbox/receipt only: it never replaces or
-- deletes usage_rollup rows, and its payload contains one sanitized aggregate
-- summary (never conversation text, entries, tool I/O, or raw runtime events).
-- Legacy rows deliberately keep NULL member/employee attribution and are not
-- backfilled from the receiving request identity.

-- ---- usage_rollup attribution and Agent aggregate counters ----
-- Agent retains twelve USD decimal places; the former six-place column would
-- silently erase sub-cent usage before Manager statistics/delivery can read it.
ALTER TABLE usage_rollup ALTER COLUMN cost_total TYPE numeric(30,12)
    USING cost_total::numeric(30,12);
ALTER TABLE usage_rollup ALTER COLUMN cost_total DROP NOT NULL;
ALTER TABLE usage_rollup ALTER COLUMN cost_total DROP DEFAULT;
-- Normalize incomplete known-price rows before enforcing the nullable-cost
-- invariant; missing evidence is unknown, never a fabricated numeric zero.
UPDATE usage_rollup
SET pricing_status = 'unknown', pricing_version = NULL, cost_total = NULL
WHERE pricing_status = 'known' AND cost_total IS NULL;
-- Existing unknown-pricing values were only compatibility zeros/estimates; keep
-- them explicitly unknown rather than allowing billing to sum them as money.
UPDATE usage_rollup SET cost_total = NULL WHERE pricing_status = 'unknown';
DO $$ BEGIN
    ALTER TABLE usage_rollup ADD CONSTRAINT ck_usage_known_cost_present
        CHECK (pricing_status <> 'known' OR cost_total IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE usage_rollup ADD COLUMN IF NOT EXISTS member_id uuid;
ALTER TABLE usage_rollup ADD COLUMN IF NOT EXISTS prompt_count integer NOT NULL DEFAULT 0;
ALTER TABLE usage_rollup ADD COLUMN IF NOT EXISTS settled_count integer NOT NULL DEFAULT 0;
ALTER TABLE usage_rollup ADD COLUMN IF NOT EXISTS input_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE usage_rollup ADD COLUMN IF NOT EXISTS output_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE usage_rollup ADD COLUMN IF NOT EXISTS cache_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE usage_rollup ADD COLUMN IF NOT EXISTS duration_ms_total bigint NOT NULL DEFAULT 0;

DO $$ BEGIN
    ALTER TABLE usage_rollup ADD CONSTRAINT ck_usage_run_count_nonnegative CHECK (run_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE usage_rollup ADD CONSTRAINT ck_usage_token_total_nonnegative CHECK (token_total >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE usage_rollup ADD CONSTRAINT ck_usage_cost_total_nonnegative CHECK (cost_total >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE usage_rollup ADD CONSTRAINT ck_usage_error_count_nonnegative CHECK (error_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE usage_rollup ADD CONSTRAINT ck_usage_duration_seconds_nonnegative CHECK (duration_seconds_total >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE usage_rollup ADD CONSTRAINT ck_usage_prompt_count_nonnegative CHECK (prompt_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE usage_rollup ADD CONSTRAINT ck_usage_settled_count_nonnegative CHECK (settled_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE usage_rollup ADD CONSTRAINT ck_usage_input_tokens_nonnegative CHECK (input_tokens >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE usage_rollup ADD CONSTRAINT ck_usage_output_tokens_nonnegative CHECK (output_tokens >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE usage_rollup ADD CONSTRAINT ck_usage_cache_tokens_nonnegative CHECK (cache_tokens >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE usage_rollup ADD CONSTRAINT ck_usage_duration_ms_nonnegative CHECK (duration_ms_total >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_usage_rollup_member_window
    ON usage_rollup (tenant_id, member_id, window_start);
CREATE INDEX IF NOT EXISTS idx_usage_rollup_employee_window
    ON usage_rollup (tenant_id, employee_id, window_start);

-- ---- usage_operator_delivery: durable per-summary delivery receipt ----
-- A summary is delivered independently so a failed item cannot hide or block
-- other retained aggregates.  Repeated delivery uses the stable idempotency key
-- stored with the exact payload revision.  A changed hourly aggregate gets a
-- new payload/key and is requeued instead of losing the cumulative update.
CREATE TABLE IF NOT EXISTS usage_operator_delivery (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL,
    enterprise_id     uuid,
    summary_id        text NOT NULL,
    idempotency_key   text NOT NULL,
    payload           jsonb NOT NULL,
    status            text NOT NULL DEFAULT 'pending',
    attempts          integer NOT NULL DEFAULT 0,
    next_attempt_at   timestamptz DEFAULT now(),
    last_error        text,
    claim_token       text,
    claimed_at        timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    sent_at           timestamptz,
    CONSTRAINT uq_usage_operator_delivery_summary UNIQUE (tenant_id, summary_id),
    CONSTRAINT uq_usage_operator_delivery_key UNIQUE (tenant_id, idempotency_key),
    CONSTRAINT ck_usage_operator_delivery_status CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    CONSTRAINT ck_usage_operator_delivery_attempts_nonnegative CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS idx_usage_operator_delivery_due
    ON usage_operator_delivery (tenant_id, status, next_attempt_at, created_at);

-- Sent receipts have no next retry timestamp; keep this explicitly nullable
-- across replays/upgrades as well as on a fresh database.
ALTER TABLE usage_operator_delivery ALTER COLUMN next_attempt_at DROP NOT NULL;
ALTER TABLE usage_operator_delivery ADD COLUMN IF NOT EXISTS member_id uuid;
ALTER TABLE usage_operator_delivery ADD COLUMN IF NOT EXISTS employee_id uuid;

CREATE INDEX IF NOT EXISTS idx_usage_operator_delivery_attribution
    ON usage_operator_delivery (tenant_id, member_id, employee_id, created_at);

-- Backfill a delivery receipt for aggregates retained before this migration.
-- This does not change usage values and does not infer missing attribution;
-- unresolved enterprise mappings remain pending until a later worker sweep.
INSERT INTO usage_operator_delivery (
    tenant_id, enterprise_id, summary_id, idempotency_key, payload,
    status, attempts, next_attempt_at, member_id, employee_id
)
SELECT
    u.tenant_id,
    tr.enterprise_id,
    u.summary_id,
    'usage_backfill_' || encode(digest(u.tenant_id::text || '|' || u.summary_id, 'sha256'), 'hex'),
    jsonb_build_object(
        'summary_id', u.summary_id,
        'tenant_id', u.tenant_id::text,
        'employee_id', CASE WHEN u.employee_id IS NULL THEN NULL ELSE u.employee_id::text END,
        'window_start', u.window_start,
        'window_end', u.window_end,
        'run_count', u.run_count,
        'token_total', u.token_total,
        'cost_total', CASE WHEN u.pricing_status = 'unknown' THEN NULL ELSE u.cost_total END,
        'pricing_version', u.pricing_version,
        'pricing_status', u.pricing_status,
        'currency', u.currency,
        'error_count', u.error_count,
        'duration_seconds_total', u.duration_seconds_total
    ),
    'pending', 0, now(), u.member_id, u.employee_id
FROM usage_rollup AS u
LEFT JOIN tenant_registry AS tr ON tr.tenant_id = u.tenant_id
ON CONFLICT (tenant_id, summary_id) DO NOTHING;

ALTER TABLE usage_operator_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_operator_delivery FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON usage_operator_delivery;
CREATE POLICY tenant_isolation ON usage_operator_delivery
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
REVOKE DELETE ON usage_operator_delivery FROM app_rw;
GRANT SELECT, INSERT, UPDATE ON usage_operator_delivery TO app_rw;
