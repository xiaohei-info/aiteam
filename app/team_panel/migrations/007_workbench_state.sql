-- 007: workbench user-state for P02 star/unread semantics

CREATE TABLE IF NOT EXISTS workbench_employee_preference (
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    user_id TEXT NOT NULL,
    employee_id TEXT NOT NULL REFERENCES employee(id),
    is_starred BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    PRIMARY KEY (enterprise_id, user_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_workbench_pref_user_starred
    ON workbench_employee_preference(enterprise_id, user_id, is_starred);

CREATE TABLE IF NOT EXISTS conversation_read_state (
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversation(id),
    last_read_message_id TEXT,
    last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    PRIMARY KEY (enterprise_id, user_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_read_state_user
    ON conversation_read_state(enterprise_id, user_id, last_read_at DESC);
