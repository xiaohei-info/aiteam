-- 004: P07 organization structure support

CREATE TABLE IF NOT EXISTS department (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    parent_id TEXT REFERENCES department(id),
    name TEXT NOT NULL,
    leader_user_id TEXT,
    visibility_scope TEXT NOT NULL DEFAULT 'enterprise'
        CHECK(visibility_scope IN ('enterprise','department','private')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_department_enterprise_parent ON department(enterprise_id, parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS uk_department_enterprise_parent_name ON department(enterprise_id, parent_id, name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS employee_org_assignment (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    employee_id TEXT NOT NULL REFERENCES employee(id),
    department_id TEXT REFERENCES department(id),
    position_title TEXT NOT NULL DEFAULT '',
    visibility_scope TEXT NOT NULL DEFAULT 'department'
        CHECK(visibility_scope IN ('enterprise','department','private')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ,
    UNIQUE(employee_id)
);
CREATE INDEX IF NOT EXISTS idx_org_assignment_enterprise_department ON employee_org_assignment(enterprise_id, department_id);
CREATE INDEX IF NOT EXISTS idx_org_assignment_employee ON employee_org_assignment(employee_id);
