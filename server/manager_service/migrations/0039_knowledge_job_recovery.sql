-- S05 metadata-only recovery and immutable custom package version fingerprints.
CREATE TABLE IF NOT EXISTS skill_package_revision (
    tenant_id uuid NOT NULL,
    skill_id text NOT NULL,
    version text NOT NULL,
    content_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, skill_id, version)
);
ALTER TABLE skill_package_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_package_revision FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON skill_package_revision;
CREATE POLICY tenant_isolation ON skill_package_revision
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON skill_package_revision TO app_rw;
-- Only the currently observable hash is known, never invented historical bytes.
INSERT INTO skill_package_revision (tenant_id, skill_id, version, content_hash)
SELECT tenant_id, skill_id, version, content_hash FROM skill_catalog
WHERE content_hash ~ '^[0-9a-f]{16}$'
  AND CASE
        WHEN jsonb_typeof(files) = 'array' THEN
            jsonb_array_length(
                CASE WHEN jsonb_typeof(files) = 'array' THEN files ELSE '[]'::jsonb END
            ) > 0
        ELSE false
      END
ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION protect_skill_package_version() RETURNS trigger AS $$
DECLARE known_hash text;
BEGIN
    IF NEW.content_hash = '' THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || ':skill:' || NEW.skill_id, 0));
    INSERT INTO skill_package_revision (tenant_id, skill_id, version, content_hash)
    VALUES (NEW.tenant_id, NEW.skill_id, NEW.version, NEW.content_hash) ON CONFLICT DO NOTHING;
    SELECT content_hash INTO known_hash FROM skill_package_revision
      WHERE tenant_id = NEW.tenant_id AND skill_id = NEW.skill_id AND version = NEW.version;
    IF known_hash IS DISTINCT FROM NEW.content_hash THEN
        RAISE EXCEPTION 'skill version content is immutable' USING ERRCODE = '23514', CONSTRAINT = 'skill_package_version_immutable';
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_skill_package_version ON skill_catalog;
CREATE TRIGGER trg_skill_package_version BEFORE INSERT OR UPDATE OF files, content_hash, version ON skill_catalog
FOR EACH ROW EXECUTE FUNCTION protect_skill_package_version();

ALTER TABLE knowledge_ingestion_job
    ADD COLUMN IF NOT EXISTS claim_owner text,
    ADD COLUMN IF NOT EXISTS lease_until timestamptz,
    ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
    ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS submission_state text NOT NULL DEFAULT 'not_submitted',
    ADD COLUMN IF NOT EXISTS file_source text,
    ADD COLUMN IF NOT EXISTS track_id text,
    ADD COLUMN IF NOT EXISTS upstream_document_id text,
    ADD COLUMN IF NOT EXISTS text_chars integer,
    ADD COLUMN IF NOT EXISTS operation_id uuid;
-- file_source NULL marks pre-S05 rows on first migration only. Legacy indexing
-- may already be upstream: never infer an unaccepted POST from a missing track.
UPDATE knowledge_ingestion_job SET
    submission_state = CASE WHEN status = 'done' THEN 'terminal'
        WHEN status = 'indexing' OR error_code IN ('INDEX_FAILED', 'BINDING_PROPAGATION_FAILED') THEN 'submitted'
        ELSE 'not_submitted' END,
    file_source = document_id::text
WHERE file_source IS NULL;
ALTER TABLE knowledge_ingestion_job ALTER COLUMN file_source SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_knowledge_job_recovery ON knowledge_ingestion_job (tenant_id, next_attempt_at)
WHERE status NOT IN ('done', 'failed') OR submission_state = 'submitted';
-- Repair the old doc/job transaction gap without inventing accepted work.
INSERT INTO knowledge_ingestion_job (tenant_id, knowledge_space_id, document_id, status, file_source, submission_state)
SELECT d.tenant_id, d.knowledge_space_id, d.id,
       CASE WHEN d.status='indexing' THEN 'indexing' ELSE 'parsing' END, d.id::text,
       CASE WHEN d.status='indexing' THEN 'submitted' ELSE 'not_submitted' END
FROM knowledge_document d
WHERE d.status IN ('uploaded','parsing','indexing','reindex_requested')
  AND NOT EXISTS (SELECT 1 FROM knowledge_ingestion_job j WHERE j.document_id=d.id AND j.status NOT IN ('done','failed'))
  AND NOT EXISTS (SELECT 1 FROM knowledge_ingestion_job j WHERE j.document_id=d.id AND j.submission_state='submitted');
UPDATE knowledge_document d SET error_code='SUBMISSION_UNKNOWN', error_message='Knowledge reconciliation required'
WHERE d.status='failed' AND EXISTS (
    SELECT 1 FROM knowledge_ingestion_job j WHERE j.document_id=d.id AND j.submission_state='submitted'
    AND j.id=(SELECT k.id FROM knowledge_ingestion_job k WHERE k.document_id=d.id ORDER BY k.created_at DESC, k.id DESC LIMIT 1)
) AND d.error_code IS DISTINCT FROM 'SUBMISSION_UNKNOWN';
ALTER TABLE knowledge_ingestion_job ALTER COLUMN file_source SET DEFAULT gen_random_uuid()::text;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_ingestion_document_scope' AND conrelid='knowledge_ingestion_job'::regclass) THEN
        ALTER TABLE knowledge_ingestion_job ADD CONSTRAINT fk_ingestion_document_scope
            FOREIGN KEY (tenant_id, knowledge_space_id, document_id)
            REFERENCES knowledge_document (tenant_id, knowledge_space_id, id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_ingestion_submission_state' AND conrelid='knowledge_ingestion_job'::regclass) THEN
        ALTER TABLE knowledge_ingestion_job ADD CONSTRAINT chk_ingestion_submission_state
            CHECK (submission_state IN ('not_submitted','submitted','terminal'));
    END IF;
END $$;
