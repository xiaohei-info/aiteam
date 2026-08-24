ALTER TABLE operation_rollup_seen ADD COLUMN IF NOT EXISTS pricing_version integer;
ALTER TABLE operation_rollup_seen ADD COLUMN IF NOT EXISTS pricing_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE operation_rollup_seen ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';
