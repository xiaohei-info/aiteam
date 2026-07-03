-- Operation solution apply statistics (issue AITEAM-330).
--
-- SolutionRepository aggregates apply_count + distinct active_enterprises per solution_id.
-- Grouped: one row per (solution_id, enterprise_id) — idempotent by enterprise. Recounts
-- apply_count = COUNT(*), active_enterprises = COUNT(DISTINCT enterprise_id).
-- Single-writer Operator.

CREATE TABLE IF NOT EXISTS solution_stat (
    solution_id     text NOT NULL,
    enterprise_id   text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (solution_id, enterprise_id)
);

CREATE INDEX IF NOT EXISTS idx_solution_stat_solution ON solution_stat (solution_id);
CREATE INDEX IF NOT EXISTS idx_solution_stat_enterprise ON solution_stat (enterprise_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON solution_stat TO app_rw;
