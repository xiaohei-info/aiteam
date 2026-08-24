-- Preserve F01 Operator enterprise_id so Manager can report enterprise rollups.
ALTER TABLE tenant_registry ADD COLUMN IF NOT EXISTS enterprise_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_registry_enterprise_id
ON tenant_registry(enterprise_id) WHERE enterprise_id IS NOT NULL;

-- Optional backfill for the historical single-DB test deployment. Production Manager
-- databases do not own enterprise_account, so this conditional remains a no-op there.
DO $$ BEGIN
    IF to_regclass('public.enterprise_account') IS NOT NULL THEN
        UPDATE tenant_registry t
        SET enterprise_id = a.enterprise_id
        FROM enterprise_account a
        WHERE t.enterprise_id IS NULL AND a.tenant_id = t.tenant_id;
    END IF;
END $$;
