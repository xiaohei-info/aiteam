-- Employee references Operator-owned platform Provider/model; Manager does not own Provider truth (D18).
ALTER TABLE employee ADD COLUMN IF NOT EXISTS platform_model_ref jsonb;

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
        NEW.memory_policy IS DISTINCT FROM OLD.memory_policy
    )) THEN
        NEW.version := COALESCE(OLD.version, 0) + 1;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
