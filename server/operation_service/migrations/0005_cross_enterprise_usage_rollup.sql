-- Operation cross-enterprise usage rollup (issue AITEAM-330).
--
-- Mirrors CrossEnterpriseRollupRepository in-memory shape:
--   - operation_rollup_seen: one row per (enterprise_id, summary_id) — idempotent by
--     summary_id (ON CONFLICT DO NOTHING). Powers summaries_for/all_summaries/report().
--   - cross_enterprise_usage_rollup: per-enterprise aggregated counters + window bounds
--     (mirrors EnterpriseRollupRow). Recalculated from seen rows; single-writer Operator.
--
-- Only operation-side **aggregate** scalars + summary_id (no member/session/token detail).

CREATE TABLE IF NOT EXISTS operation_rollup_seen (
    enterprise_id          uuid NOT NULL,
    summary_id             text NOT NULL PRIMARY KEY,
    tenant_id              text NOT NULL DEFAULT '',
    employee_id            text,
    run_count              integer NOT NULL DEFAULT 0,
    token_total            integer NOT NULL DEFAULT 0,
    cost_total             numeric NOT NULL DEFAULT 0,
    error_count            integer NOT NULL DEFAULT 0,
    duration_seconds_total integer NOT NULL DEFAULT 0,
    window_start           timestamptz NOT NULL,
    window_end             timestamptz NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rollup_seen_enterprise
    ON operation_rollup_seen (enterprise_id, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON operation_rollup_seen TO app_rw;

CREATE TABLE IF NOT EXISTS cross_enterprise_usage_rollup (
    enterprise_id          uuid PRIMARY KEY,
    tenant_id              text NOT NULL DEFAULT '',
    run_count              integer NOT NULL DEFAULT 0,
    token_total            integer NOT NULL DEFAULT 0,
    cost_total             numeric NOT NULL DEFAULT 0,
    error_count            integer NOT NULL DEFAULT 0,
    duration_seconds_total integer NOT NULL DEFAULT 0,
    summary_count          integer NOT NULL DEFAULT 0,
    window_start           timestamptz,
    window_end             timestamptz,
    updated_at             timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON cross_enterprise_usage_rollup TO app_rw;
