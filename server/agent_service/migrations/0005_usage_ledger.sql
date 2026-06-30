-- 单 run token 级计量明细（A5 审计回流，#293）。
-- 与脱敏 outbox（聚合摘要）互补：outbox 存聚合后的 UsageSummary，本表存每个 run 的 input/output token、
-- cost、error、duration 明细，供按 employee_id / run_id 对账。
-- 幂等键 (run_id, source_type)：同一 run+来源反复写入只更新不重复。

CREATE TABLE IF NOT EXISTS usage_ledger (
    id               TEXT PRIMARY KEY,
    tenant_id        TEXT NOT NULL,
    employee_id      TEXT,
    run_id           TEXT NOT NULL,
    conversation_id  TEXT,
    input_tokens     INTEGER NOT NULL DEFAULT 0,
    output_tokens    INTEGER NOT NULL DEFAULT 0,
    total_tokens     INTEGER NOT NULL DEFAULT 0,
    cost_cents       INTEGER NOT NULL DEFAULT 0,   -- 整数分，禁 float（02 §10.3.5）
    error            INTEGER NOT NULL DEFAULT 0,   -- boolean 0/1
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    source_type      TEXT NOT NULL,                -- run_summary | usage_event | backfill
    occurred_at      TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    deleted_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_run_source
    ON usage_ledger (run_id, source_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_employee ON usage_ledger (employee_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ledger_tenant ON usage_ledger (tenant_id, occurred_at);
