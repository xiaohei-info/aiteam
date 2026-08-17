-- Remove the retired multi-executor selector from employee configuration.
-- Fresh databases never create this column; this remains idempotent for databases
-- initialized before the Pi Agent cutover.
ALTER TABLE employee DROP COLUMN IF EXISTS runtime_binding;
