-- 004: management/commercial data-path foundation

CREATE TABLE IF NOT EXISTS connector_definition (
    id TEXT PRIMARY KEY,
    provider_code TEXT NOT NULL,
    connector_type TEXT NOT NULL
        CHECK(connector_type IN ('oauth_connector','api_key_connector','mcp_server','webhook_target')),
    display_name TEXT NOT NULL DEFAULT '',
    auth_scheme TEXT NOT NULL DEFAULT 'opaque_ref'
        CHECK(auth_scheme IN ('oauth2','api_key','mcp','webhook','opaque_ref')),
    config_schema_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','deprecated','hidden')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_connector_definition_provider_type
    ON connector_definition(provider_code, connector_type)
    WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS uk_emp_skill;
CREATE UNIQUE INDEX IF NOT EXISTS uk_emp_skill_active
    ON employee_skill_binding(employee_id, skill_code)
    WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS uk_emp_kb;
CREATE UNIQUE INDEX IF NOT EXISTS uk_emp_kb_active
    ON employee_knowledge_binding(employee_id, knowledge_base_id)
    WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS uk_emp_memory;
CREATE UNIQUE INDEX IF NOT EXISTS uk_emp_memory_active
    ON employee_memory_binding(employee_id)
    WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS uk_emp_connector;
CREATE UNIQUE INDEX IF NOT EXISTS uk_emp_connector_active
    ON employee_connector_binding(employee_id, connector_id)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS solution_apply_record (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    solution_id TEXT NOT NULL REFERENCES industry_solution(id),
    idempotency_key TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'append'
        CHECK(mode IN ('append')),
    status TEXT NOT NULL DEFAULT 'succeeded'
        CHECK(status IN ('pending','succeeded','failed','cancelled')),
    requested_by TEXT,
    department_id TEXT,
    created_employee_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_knowledge_base_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_solution_apply_record_idempotency
    ON solution_apply_record(enterprise_id, solution_id, idempotency_key)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_solution_apply_record_solution_status
    ON solution_apply_record(solution_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_ledger (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    employee_id TEXT NOT NULL REFERENCES employee(id),
    conversation_id TEXT REFERENCES conversation(id),
    run_id TEXT NOT NULL REFERENCES team_run(id),
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    source_type TEXT NOT NULL DEFAULT 'run_summary'
        CHECK(source_type IN ('run_summary','usage_event','backfill')),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS conversation_id TEXT;
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS cost_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'run_summary';
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS uk_usage_ledger_run_source
    ON usage_ledger(run_id, source_type);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_enterprise_occurred
    ON usage_ledger(enterprise_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_employee_occurred
    ON usage_ledger(employee_id, occurred_at DESC);
