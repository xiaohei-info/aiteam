-- Additive RAG policy metadata. No inference about physically deleted history.
ALTER TABLE employee_knowledge_binding
    ADD COLUMN IF NOT EXISTS policy_revision bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS policy_source text,
    ADD COLUMN IF NOT EXISTS policy_actor uuid,
    ADD COLUMN IF NOT EXISTS policy_updated_at timestamptz,
    ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
UPDATE employee_knowledge_binding SET policy_source = 'legacy_observed' WHERE policy_source IS NULL;
ALTER TABLE employee_knowledge_binding ALTER COLUMN policy_source SET DEFAULT 'legacy_observed';
ALTER TABLE employee_knowledge_binding ALTER COLUMN policy_source SET NOT NULL;

ALTER TABLE knowledge_document_binding
    ADD COLUMN IF NOT EXISTS enabled boolean,
    ADD COLUMN IF NOT EXISTS policy_revision bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS policy_source text,
    ADD COLUMN IF NOT EXISTS policy_actor uuid,
    ADD COLUMN IF NOT EXISTS policy_updated_at timestamptz,
    ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
-- Revoked is also written by document deletion, not evidence of employee admin intent.
UPDATE knowledge_document_binding
SET policy_source = CASE WHEN status = 'revoked' THEN 'legacy_resource' ELSE 'inherit' END
WHERE policy_source IS NULL;
ALTER TABLE knowledge_document_binding ALTER COLUMN policy_source SET DEFAULT 'inherit';
ALTER TABLE knowledge_document_binding ALTER COLUMN policy_source SET NOT NULL;

-- Validate observed relationships, never repair invalid legacy ownership by guessing.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_employee_tenant_id' AND conrelid = 'employee'::regclass) THEN
        ALTER TABLE employee ADD CONSTRAINT uq_employee_tenant_id UNIQUE (tenant_id, id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_knowledge_policy_employee' AND conrelid = 'employee_knowledge_binding'::regclass) THEN
        ALTER TABLE employee_knowledge_binding ADD CONSTRAINT fk_knowledge_policy_employee
            FOREIGN KEY (tenant_id, employee_id) REFERENCES employee(tenant_id, id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_document_policy_employee' AND conrelid = 'knowledge_document_binding'::regclass) THEN
        ALTER TABLE knowledge_document_binding ADD CONSTRAINT fk_document_policy_employee
            FOREIGN KEY (tenant_id, employee_id) REFERENCES employee(tenant_id, id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_document_policy_document' AND conrelid = 'knowledge_document_binding'::regclass) THEN
        ALTER TABLE knowledge_document_binding ADD CONSTRAINT fk_document_policy_document
            FOREIGN KEY (tenant_id, knowledge_space_id, document_id)
            REFERENCES knowledge_document(tenant_id, knowledge_space_id, id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_whole_knowledge_tombstone' AND conrelid = 'employee_knowledge_binding'::regclass) THEN
        ALTER TABLE employee_knowledge_binding ADD CONSTRAINT chk_whole_knowledge_tombstone
            CHECK (revoked_at IS NULL OR enabled = false);
        ALTER TABLE knowledge_document_binding ADD CONSTRAINT chk_document_knowledge_tombstone
            CHECK (revoked_at IS NULL OR enabled IS FALSE);
    END IF;
END $$;

-- One comparable effective revision, in the same RLS transaction as the policy write.
CREATE OR REPLACE FUNCTION knowledge_policy_touch_employee() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF TG_TABLE_NAME = 'employee_knowledge_binding' OR NEW.enabled IS NOT NULL THEN
            UPDATE employee SET version = version + 1 WHERE id = NEW.employee_id;
        END IF;
    ELSIF ROW(NEW.enabled, NEW.revoked_at, NEW.policy_revision)
          IS DISTINCT FROM ROW(OLD.enabled, OLD.revoked_at, OLD.policy_revision) THEN
        UPDATE employee SET version = version + 1 WHERE id = NEW.employee_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS knowledge_policy_revision ON employee_knowledge_binding;
CREATE TRIGGER knowledge_policy_revision AFTER INSERT OR UPDATE ON employee_knowledge_binding
    FOR EACH ROW EXECUTE FUNCTION knowledge_policy_touch_employee();
DROP TRIGGER IF EXISTS knowledge_policy_revision ON knowledge_document_binding;
CREATE TRIGGER knowledge_policy_revision AFTER INSERT OR UPDATE ON knowledge_document_binding
    FOR EACH ROW EXECUTE FUNCTION knowledge_policy_touch_employee();
