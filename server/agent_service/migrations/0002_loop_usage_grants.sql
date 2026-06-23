-- Agent 本地 loop/usage/grants 持久化（#159）。
-- datetime 存 ISO 字符串，dict/复杂对象存 JSON 文本。

-- Loop 本地调度（A3，06 §7.6，D19）
CREATE TABLE IF NOT EXISTS loops (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    cron            TEXT NOT NULL,
    run_spec        TEXT NOT NULL,  -- RunSpec JSON
    title           TEXT,
    status          TEXT NOT NULL,
    fire_count      INTEGER NOT NULL DEFAULT 0,
    last_run_id     TEXT,
    last_fired_at   TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loops_conv ON loops (conversation_id);
CREATE INDEX IF NOT EXISTS idx_loops_status ON loops (status);

-- Usage/Audit 脱敏摘要 outbox（A5，04 §6.5）
CREATE TABLE IF NOT EXISTS outbox_items (
    summary_id  TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    kind        TEXT NOT NULL,
    usage       TEXT,              -- UsageSummary JSON or NULL
    audit       TEXT,              -- AuditSummaryEvent JSON or NULL
    status      TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_items (status, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_tenant ON outbox_items (tenant_id);

-- 已授权专家本地只读投影（A4，04 §6.2，D12/D14）
CREATE TABLE IF NOT EXISTS loaded_expert_projections (
    employee_id      TEXT PRIMARY KEY,
    tenant_id        TEXT NOT NULL,
    version          TEXT NOT NULL,
    display_name     TEXT NOT NULL,
    runtime_binding  TEXT,
    synced_at        TEXT,
    revoked          INTEGER NOT NULL DEFAULT 0  -- boolean: 0=false, 1=true
);
CREATE INDEX IF NOT EXISTS idx_projections_revoked ON loaded_expert_projections (revoked);

-- 冻结执行快照（A4，04 §6.3，D5）
CREATE TABLE IF NOT EXISTS employee_execution_snapshots (
    employee_id         TEXT NOT NULL,
    version             TEXT NOT NULL,
    snapshot_version    TEXT NOT NULL,
    display_name        TEXT NOT NULL,
    persona             TEXT,
    model_policy        TEXT NOT NULL,         -- ModelPolicy JSON
    runtime_policy      TEXT NOT NULL,         -- RuntimePolicy JSON
    tools               TEXT NOT NULL,         -- JSON array
    skills              TEXT NOT NULL,         -- JSON array
    knowledge_refs      TEXT NOT NULL,         -- JSON array
    connector_refs      TEXT NOT NULL,         -- JSON array
    memory_policy       TEXT,                  -- JSON or NULL
    frozen_at           TEXT NOT NULL,
    PRIMARY KEY (employee_id, snapshot_version)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_employee ON employee_execution_snapshots (employee_id, frozen_at);
