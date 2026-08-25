-- Pi-native solution metadata (2026-08-25).
-- Keep historical solution_instance columns during rolling deployment; new execution
-- projections use the coordinator/roster fields below and never copy legacy plan prompts,
-- tenant knowledge refs, or default grants into employee configuration.
ALTER TABLE solution_instance
    ADD COLUMN IF NOT EXISTS coordinator_employee_id uuid,
    ADD COLUMN IF NOT EXISTS coordinator_instructions text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS workflow_skill_ref jsonb,
    ADD COLUMN IF NOT EXISTS output_requirements text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_solution_instance_coordinator
    ON solution_instance (tenant_id, coordinator_employee_id);
