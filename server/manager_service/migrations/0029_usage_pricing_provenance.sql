-- Preserve Agent-frozen platform pricing provenance in aggregate-only usage rows.
ALTER TABLE usage_rollup ADD COLUMN IF NOT EXISTS pricing_version integer;
ALTER TABLE usage_rollup ADD COLUMN IF NOT EXISTS pricing_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE usage_rollup ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';

DO $$ BEGIN
    ALTER TABLE usage_rollup ADD CONSTRAINT ck_usage_pricing_status CHECK (pricing_status IN ('known','unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE usage_rollup ADD CONSTRAINT ck_usage_currency CHECK (currency = 'USD');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
