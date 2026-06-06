-- 005: canonical B02 enterprise skill install governance

CREATE TABLE IF NOT EXISTS enterprise_skill_install (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    skill_code TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    source_marketplace TEXT NOT NULL DEFAULT 'custom',
    version TEXT NOT NULL DEFAULT '1.0.0',
    latest_version TEXT NOT NULL DEFAULT '1.0.0',
    scope_mode TEXT NOT NULL DEFAULT 'selected_employees',
    install_status TEXT NOT NULL DEFAULT 'active',
    manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);

ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS enterprise_id TEXT REFERENCES enterprise(id);
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS skill_code TEXT;
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS source_marketplace TEXT NOT NULL DEFAULT 'custom';
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS version TEXT NOT NULL DEFAULT '1.0.0';
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS latest_version TEXT NOT NULL DEFAULT '1.0.0';
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS scope_mode TEXT NOT NULL DEFAULT 'selected_employees';
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS install_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DO $$
BEGIN
    UPDATE enterprise_skill_install
    SET display_name = COALESCE(display_name, ''),
        description = COALESCE(description, ''),
        source_marketplace = CASE
            WHEN source_marketplace IN ('clawhub','skillhub','custom','builtin') THEN source_marketplace
            ELSE 'custom'
        END,
        version = COALESCE(NULLIF(version, ''), '1.0.0'),
        latest_version = COALESCE(NULLIF(latest_version, ''), COALESCE(NULLIF(version, ''), '1.0.0')),
        scope_mode = CASE
            WHEN scope_mode IN ('all_employees','selected_employees') THEN scope_mode
            ELSE 'selected_employees'
        END,
        install_status = CASE
            WHEN install_status IN ('active','update_available','uninstalled') THEN install_status
            ELSE 'active'
        END,
        manifest_json = COALESCE(manifest_json, '{}'::jsonb);

    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enterprise_skill_install_source_marketplace_check') THEN
        ALTER TABLE enterprise_skill_install DROP CONSTRAINT enterprise_skill_install_source_marketplace_check;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enterprise_skill_install_scope_mode_check') THEN
        ALTER TABLE enterprise_skill_install DROP CONSTRAINT enterprise_skill_install_scope_mode_check;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enterprise_skill_install_install_status_check') THEN
        ALTER TABLE enterprise_skill_install DROP CONSTRAINT enterprise_skill_install_install_status_check;
    END IF;

    ALTER TABLE enterprise_skill_install
        ADD CONSTRAINT enterprise_skill_install_source_marketplace_check
        CHECK (source_marketplace IN ('clawhub','skillhub','custom','builtin'));
    ALTER TABLE enterprise_skill_install
        ADD CONSTRAINT enterprise_skill_install_scope_mode_check
        CHECK (scope_mode IN ('all_employees','selected_employees'));
    ALTER TABLE enterprise_skill_install
        ADD CONSTRAINT enterprise_skill_install_install_status_check
        CHECK (install_status IN ('active','update_available','uninstalled'));
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uk_enterprise_skill_install_active
    ON enterprise_skill_install(enterprise_id, skill_code)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_enterprise_skill_install_enterprise
    ON enterprise_skill_install(enterprise_id, created_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_enterprise_skill_install_skill_code
    ON enterprise_skill_install(skill_code)
    WHERE deleted_at IS NULL;
