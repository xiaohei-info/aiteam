-- 0033: make department assignment part of the employee snapshot contract.
-- department_ids was added by 0012, but the later platform-model trigger (0028)
-- omitted it from the version bump condition. Recreate the trigger function here
-- so assignment changes invalidate Agent snapshots without making lifecycle-only
-- updates look like configuration changes.

CREATE OR REPLACE FUNCTION employee_touch_updated_at()
RETURNS trigger AS $$
BEGIN
    IF (TG_OP = 'UPDATE' AND (
        NEW.display_name IS DISTINCT FROM OLD.display_name OR
        NEW.persona IS DISTINCT FROM OLD.persona OR
        NEW.model IS DISTINCT FROM OLD.model OR
        NEW.provider_ref IS DISTINCT FROM OLD.provider_ref OR
        NEW.platform_model_ref IS DISTINCT FROM OLD.platform_model_ref OR
        NEW.thinking_level IS DISTINCT FROM OLD.thinking_level OR
        NEW.timeout_seconds IS DISTINCT FROM OLD.timeout_seconds OR
        NEW.tools IS DISTINCT FROM OLD.tools OR
        NEW.skills IS DISTINCT FROM OLD.skills OR
        NEW.knowledge_refs IS DISTINCT FROM OLD.knowledge_refs OR
        NEW.connector_refs IS DISTINCT FROM OLD.connector_refs OR
        NEW.memory_policy IS DISTINCT FROM OLD.memory_policy OR
        NEW.department_ids IS DISTINCT FROM OLD.department_ids
    )) THEN
        NEW.version := COALESCE(OLD.version, 0) + 1;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_employee_config_touch ON employee;
CREATE TRIGGER trg_employee_config_touch
BEFORE UPDATE ON employee
FOR EACH ROW
EXECUTE FUNCTION employee_touch_updated_at();
