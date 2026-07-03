-- Operation catalog template truth (issue AITEAM-330).
--
-- CatalogRepository holds operator-side template truth (expert / solution templates)
-- with lifecycle + visible_scope. Keyed by (catalog_type, template_id). Idempotent.

CREATE TABLE IF NOT EXISTS catalog_template (
    catalog_type    text NOT NULL,
    template_id     text NOT NULL,
    version         text NOT NULL,
    display_name    text NOT NULL,
    status          text NOT NULL,
    visible_scope   jsonb,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (catalog_type, template_id)
);

-- catalog_type enumeration: expert_template / solution_template
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'catalog_template'::regclass AND conname = 'ck_catalog_template_catalog_type'
    ) THEN
        ALTER TABLE catalog_template DROP CONSTRAINT ck_catalog_template_catalog_type;
    END IF;
    ALTER TABLE catalog_template
        ADD CONSTRAINT ck_catalog_template_catalog_type
        CHECK (catalog_type IN ('expert_template', 'solution_template'));

    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'catalog_template'::regclass AND conname = 'ck_catalog_template_status'
    ) THEN
        ALTER TABLE catalog_template DROP CONSTRAINT ck_catalog_template_status;
    END IF;
    ALTER TABLE catalog_template
        ADD CONSTRAINT ck_catalog_template_status
        CHECK (status IN ('draft', 'published', 'unpublished'));
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON catalog_template TO app_rw;
