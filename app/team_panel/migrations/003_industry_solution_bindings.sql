-- 003: Minimal industry solution + template binding tables for solution apply

CREATE TABLE IF NOT EXISTS industry_solution (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','published','retired')),
    tags_json JSONB DEFAULT '[]'::jsonb,
    default_kb_blueprint_json JSONB DEFAULT '{}'::jsonb,
    default_skill_bundle_json JSONB DEFAULT '{}'::jsonb,
    default_collaboration_template_ref TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_industry_solution_status ON industry_solution(status);

CREATE TABLE IF NOT EXISTS solution_template_binding (
    id TEXT PRIMARY KEY,
    solution_id TEXT NOT NULL REFERENCES industry_solution(id) ON DELETE CASCADE,
    template_id TEXT NOT NULL REFERENCES agent_template(id),
    sequence_no INTEGER NOT NULL DEFAULT 1,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_solution_template_binding_solution_sequence
    ON solution_template_binding(solution_id, sequence_no)
    WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uk_solution_template_binding_solution_template
    ON solution_template_binding(solution_id, template_id)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_solution_template_binding_template
    ON solution_template_binding(template_id);
