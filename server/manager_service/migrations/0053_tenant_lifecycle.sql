-- R5 企业生命周期：Operator 经 /api/manager/tenants/{id}/status 下发；purge 后记录时间并释放企业代码 / slug。
ALTER TABLE tenant_registry ADD COLUMN IF NOT EXISTS status_reason text;
ALTER TABLE tenant_registry ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;
ALTER TABLE tenant_registry ADD COLUMN IF NOT EXISTS purged_at timestamptz;
UPDATE tenant_registry SET status = 'active'
 WHERE status IS NULL OR status NOT IN ('active','suspended','banned','closed','deleted');
ALTER TABLE tenant_registry DROP CONSTRAINT IF EXISTS chk_tenant_registry_status;
ALTER TABLE tenant_registry ADD CONSTRAINT chk_tenant_registry_status
    CHECK (status IN ('active','suspended','banned','closed','deleted'));
