-- Repair cross-tier usage rollup persistence without rewriting the original DDL.
--
-- operation_rollup_seen previously used a global summary_id primary key. A
-- summary id is only idempotent within the enterprise that produced it, so
-- the durable key is (enterprise_id, summary_id). Unknown pricing is stored
-- as NULL cost_total; pricing_status remains the provenance discriminator.

ALTER TABLE operation_rollup_seen
    ALTER COLUMN cost_total DROP NOT NULL,
    ALTER COLUMN cost_total DROP DEFAULT;

ALTER TABLE cross_enterprise_usage_rollup
    ALTER COLUMN cost_total DROP NOT NULL,
    ALTER COLUMN cost_total DROP DEFAULT;

DO $$
DECLARE
    primary_key_name text;
BEGIN
    SELECT conname
      INTO primary_key_name
      FROM pg_constraint
     WHERE conrelid = 'operation_rollup_seen'::regclass
       AND contype = 'p';

    IF primary_key_name IS NOT NULL THEN
        EXECUTE format(
            'ALTER TABLE operation_rollup_seen DROP CONSTRAINT %I',
            primary_key_name
        );
    END IF;

    ALTER TABLE operation_rollup_seen
        ADD CONSTRAINT operation_rollup_seen_pkey PRIMARY KEY (enterprise_id, summary_id);
END
$$;
