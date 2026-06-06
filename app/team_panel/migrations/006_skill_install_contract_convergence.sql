-- 006: converge enterprise_skill_install to canonical B02 contract
-- Drop pre-existing constraint/index that may block rename
DO $$
BEGIN
    EXECUTE 'ALTER TABLE enterprise_skill_install DROP CONSTRAINT IF EXISTS enterprise_skill_install_skill_code_key';
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DROP INDEX IF EXISTS idx_esi_enterprise_skill;
DROP INDEX IF EXISTS idx_esi_skill_code;
DROP INDEX IF EXISTS uk_enterprise_skill_install_active;
DROP INDEX IF EXISTS idx_enterprise_skill_install_enterprise;
DROP INDEX IF EXISTS idx_enterprise_skill_install_skill_code;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'enterprise_skill_install' AND column_name = 'skill_name'
    ) THEN
        ALTER TABLE enterprise_skill_install RENAME COLUMN skill_name TO display_name_stale;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'enterprise_skill_install' AND column_name = 'installed_version'
    ) THEN
        ALTER TABLE enterprise_skill_install RENAME COLUMN installed_version TO version_stale;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'enterprise_skill_install' AND column_name = 'status'
    ) THEN
        ALTER TABLE enterprise_skill_install RENAME COLUMN status TO install_status_stale;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'enterprise_skill_install' AND column_name = 'source_type'
    ) THEN
        ALTER TABLE enterprise_skill_install RENAME COLUMN source_type TO source_marketplace_stale;
    END IF;
END $$;

-- Add canonical columns
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS source_marketplace TEXT NOT NULL DEFAULT 'custom';
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS version TEXT NOT NULL DEFAULT '1.0.0';
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS latest_version TEXT NOT NULL DEFAULT '1.0.0';
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS scope_mode TEXT NOT NULL DEFAULT 'selected_employees';
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS install_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE enterprise_skill_install ADD COLUMN IF NOT EXISTS manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Migrate data from stale columns
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'enterprise_skill_install' AND column_name = 'display_name_stale'
    ) THEN
        UPDATE enterprise_skill_install
        SET display_name = display_name_stale
        WHERE display_name = '' AND display_name_stale IS NOT NULL AND display_name_stale != '';
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'enterprise_skill_install' AND column_name = 'version_stale'
    ) THEN
        UPDATE enterprise_skill_install
        SET version = version_stale
        WHERE version = '1.0.0' AND version_stale IS NOT NULL AND version_stale != '1.0.0';
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'enterprise_skill_install' AND column_name = 'install_status_stale'
    ) THEN
        UPDATE enterprise_skill_install
        SET install_status = install_status_stale
        WHERE install_status_stale IS NOT NULL AND install_status_stale != 'active';
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'enterprise_skill_install' AND column_name = 'source_marketplace_stale'
    ) THEN
        UPDATE enterprise_skill_install
        SET source_marketplace = source_marketplace_stale
        WHERE source_marketplace_stale IS NOT NULL AND source_marketplace_stale IN ('clawhub','skillhub','custom','builtin');
    END IF;
END $$;

-- Drop stale columns
ALTER TABLE enterprise_skill_install DROP COLUMN IF EXISTS display_name_stale;
ALTER TABLE enterprise_skill_install DROP COLUMN IF EXISTS version_stale;
ALTER TABLE enterprise_skill_install DROP COLUMN IF EXISTS install_status_stale;
ALTER TABLE enterprise_skill_install DROP COLUMN IF EXISTS source_marketplace_stale;

-- Recreate indexes
CREATE UNIQUE INDEX IF NOT EXISTS uk_enterprise_skill_install_active
    ON enterprise_skill_install(enterprise_id, skill_code)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_enterprise_skill_install_enterprise
    ON enterprise_skill_install(enterprise_id, created_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_enterprise_skill_install_skill_code
    ON enterprise_skill_install(skill_code)
    WHERE deleted_at IS NULL;
