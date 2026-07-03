-- Operation recharge records + enterprise_account.total_recharged (issue AITEAM-330).
--
-- AdminRepository.add_recharge() persists each entry and bumps the per-enterprise
-- running total (mirrors the in-memory Accumulator). The recharge record is the
-- source of truth; total_recharged is a denormalized cache on enterprise_account
-- updated in the same transaction. Idempotent (IF NOT EXISTS / ADD COLUMN).
--
-- Single-writer (CLAUDE/AGENTS §3.2): enterprise_account + operation_recharge are
-- written by Operator only.

-- Denormalized running total on enterprise_account (AdminRepository.total_recharged).
-- Mirrors the in-memory enterprise.total_recharged accumulator.
ALTER TABLE enterprise_account
    ADD COLUMN IF NOT EXISTS total_recharged numeric NOT NULL DEFAULT 0;

-- Recharge records: one row per recharge. Source of truth for list_recharges().
CREATE TABLE IF NOT EXISTS operation_recharge_record (
    recharge_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id  uuid NOT NULL REFERENCES enterprise_account(enterprise_id),
    amount         numeric NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recharge_record_enterprise
    ON operation_recharge_record (enterprise_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON operation_recharge_record TO app_rw;
