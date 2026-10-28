-- Startup replays every migration file, so this data refresh must guard itself.
-- Claim and update share one statement: an update failure also rolls back the claim.
CREATE TABLE IF NOT EXISTS manager_data_migration_receipt (
    migration_id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

WITH first_application AS (
    INSERT INTO manager_data_migration_receipt (migration_id)
    VALUES ('0047_employee_provenance_refresh')
    ON CONFLICT (migration_id) DO NOTHING
    RETURNING migration_id
)
UPDATE employee
SET version = version + 1
WHERE source_template_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM first_application);
