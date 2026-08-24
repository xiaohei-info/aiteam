-- Preserve F01 Operator enterprise_id so Manager can report enterprise rollups.
ALTER TABLE tenant_registry ADD COLUMN IF NOT EXISTS enterprise_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_registry_enterprise_id
ON tenant_registry(enterprise_id) WHERE enterprise_id IS NOT NULL;
