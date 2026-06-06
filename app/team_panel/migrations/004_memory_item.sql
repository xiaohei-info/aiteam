-- 004: canonical B07 memory item contract convergence

CREATE TABLE IF NOT EXISTS memory_item (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    employee_id TEXT NOT NULL REFERENCES employee(id),
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'event'
        CHECK (category IN ('preference','habit','decision','event')),
    importance INTEGER NOT NULL DEFAULT 3
        CHECK (importance BETWEEN 1 AND 5),
    source_type TEXT NOT NULL DEFAULT 'manual'
        CHECK (source_type IN ('manual','extraction','system_policy')),
    tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    visibility_scope TEXT NOT NULL DEFAULT 'enterprise'
        CHECK (visibility_scope IN ('enterprise','admin_only')),
    runtime_ref_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);

ALTER TABLE memory_item ADD COLUMN IF NOT EXISTS enterprise_id TEXT REFERENCES enterprise(id);
ALTER TABLE memory_item ADD COLUMN IF NOT EXISTS employee_id TEXT REFERENCES employee(id);
ALTER TABLE memory_item ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '';
ALTER TABLE memory_item ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'event';
ALTER TABLE memory_item ADD COLUMN IF NOT EXISTS importance INTEGER NOT NULL DEFAULT 3;
ALTER TABLE memory_item ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE memory_item ADD COLUMN IF NOT EXISTS tags_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE memory_item ADD COLUMN IF NOT EXISTS visibility_scope TEXT NOT NULL DEFAULT 'enterprise';
ALTER TABLE memory_item ADD COLUMN IF NOT EXISTS runtime_ref_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE memory_item ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE memory_item ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE memory_item ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE memory_item ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE memory_item ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE memory_item ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'memory_item' AND column_name = 'extraction_run_id'
    ) THEN
        UPDATE memory_item
        SET runtime_ref_json = CASE
            WHEN COALESCE(runtime_ref_json, '{}'::jsonb) = '{}'::jsonb AND extraction_run_id IS NOT NULL THEN
                jsonb_build_object('source_kind', 'run_event', 'run_id', extraction_run_id)
            ELSE COALESCE(runtime_ref_json, '{}'::jsonb)
        END;
    END IF;

    UPDATE memory_item
    SET importance = LEAST(GREATEST(COALESCE(importance, 3), 1), 5),
        source_type = CASE WHEN source_type = 'auto' THEN 'extraction' ELSE COALESCE(source_type, 'manual') END,
        category = COALESCE(NULLIF(category, ''), 'event'),
        visibility_scope = CASE WHEN visibility_scope IN ('enterprise', 'admin_only') THEN visibility_scope ELSE 'enterprise' END,
        tags_json = COALESCE(tags_json, '[]'::jsonb),
        runtime_ref_json = COALESCE(runtime_ref_json, '{}'::jsonb);

    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_item_category_check') THEN
        ALTER TABLE memory_item DROP CONSTRAINT memory_item_category_check;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_item_importance_check') THEN
        ALTER TABLE memory_item DROP CONSTRAINT memory_item_importance_check;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_item_source_type_check') THEN
        ALTER TABLE memory_item DROP CONSTRAINT memory_item_source_type_check;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_item_visibility_scope_check') THEN
        ALTER TABLE memory_item DROP CONSTRAINT memory_item_visibility_scope_check;
    END IF;

    ALTER TABLE memory_item ADD CONSTRAINT memory_item_category_check CHECK (category IN ('preference','habit','decision','event'));
    ALTER TABLE memory_item ADD CONSTRAINT memory_item_importance_check CHECK (importance BETWEEN 1 AND 5);
    ALTER TABLE memory_item ADD CONSTRAINT memory_item_source_type_check CHECK (source_type IN ('manual','extraction','system_policy'));
    ALTER TABLE memory_item ADD CONSTRAINT memory_item_visibility_scope_check CHECK (visibility_scope IN ('enterprise','admin_only'));
END $$;

CREATE TABLE IF NOT EXISTS memory_review_decision (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    memory_item_id TEXT NOT NULL REFERENCES memory_item(id),
    reviewer_user_id TEXT NOT NULL,
    decision TEXT NOT NULL DEFAULT 'pending'
        CHECK (decision IN ('pending','confirmed','rejected','corrected')),
    comment TEXT,
    corrected_content TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);

ALTER TABLE memory_review_decision ADD COLUMN IF NOT EXISTS enterprise_id TEXT REFERENCES enterprise(id);
ALTER TABLE memory_review_decision ADD COLUMN IF NOT EXISTS reviewer_user_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE memory_review_decision ADD COLUMN IF NOT EXISTS decision TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE memory_review_decision ADD COLUMN IF NOT EXISTS comment TEXT;
ALTER TABLE memory_review_decision ADD COLUMN IF NOT EXISTS corrected_content TEXT;
ALTER TABLE memory_review_decision ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE memory_review_decision ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE memory_review_decision ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE memory_review_decision ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE memory_review_decision ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_review_decision_decision_check') THEN
        ALTER TABLE memory_review_decision DROP CONSTRAINT memory_review_decision_decision_check;
    END IF;
    ALTER TABLE memory_review_decision
        ADD CONSTRAINT memory_review_decision_decision_check
        CHECK (decision IN ('pending','confirmed','rejected','corrected'));
END $$;

CREATE INDEX IF NOT EXISTS idx_memory_item_enterprise_employee_created
    ON memory_item(enterprise_id, employee_id, created_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memory_item_enterprise_employee_importance
    ON memory_item(enterprise_id, employee_id, importance DESC, updated_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memory_item_tags
    ON memory_item USING GIN(tags_json);
CREATE INDEX IF NOT EXISTS idx_memory_review_decision_item
    ON memory_review_decision(memory_item_id, created_at DESC)
    WHERE deleted_at IS NULL;
