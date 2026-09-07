-- Existing self-owned factor removal routes require DELETE; tenant RLS remains unchanged.
GRANT DELETE ON passkey_credential, oauth_connection TO app_rw;

-- Lifecycle is part of the effective employee projection revision. No-op updates stay stable.
CREATE OR REPLACE FUNCTION employee_touch_updated_at()
RETURNS trigger AS $$
BEGIN
    IF (TG_OP = 'UPDATE' AND (
        NEW.display_name IS DISTINCT FROM OLD.display_name OR
        NEW.role_title IS DISTINCT FROM OLD.role_title OR
        NEW.status IS DISTINCT FROM OLD.status OR
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
