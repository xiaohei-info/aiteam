-- Manager knowledge document delete/reindex lifecycle (idempotent).
-- The Manager document remains the source of truth; LightRAG deletion is an
-- asynchronous request, so deleting/revoked states fail closed for reads.

ALTER TABLE knowledge_document
    DROP CONSTRAINT IF EXISTS chk_knowledge_document_status;
ALTER TABLE knowledge_document
    ADD CONSTRAINT chk_knowledge_document_status
    CHECK (status IN (
        'uploaded', 'parsing', 'indexing', 'ready', 'failed',
        'reindex_requested', 'deleting', 'deleted'
    ));

ALTER TABLE knowledge_ingestion_job
    DROP CONSTRAINT IF EXISTS chk_ingestion_status;
ALTER TABLE knowledge_ingestion_job
    ADD CONSTRAINT chk_ingestion_status
    CHECK (status IN ('parsing', 'indexing', 'done', 'failed', 'reindex_requested'));

ALTER TABLE knowledge_document_binding
    DROP CONSTRAINT IF EXISTS chk_binding_status;
ALTER TABLE knowledge_document_binding
    ADD CONSTRAINT chk_binding_status
    CHECK (status IN ('pending', 'ready', 'stale', 'revoked'));

CREATE TABLE IF NOT EXISTS knowledge_document_operation (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    knowledge_space_id  text NOT NULL,
    document_id         uuid NOT NULL,
    operation           text NOT NULL,
    idempotency_key     text NOT NULL,
    request_fingerprint text NOT NULL,
    status              text NOT NULL DEFAULT 'pending',
    upstream_status     text,
    error_code          text,
    error_message       text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz,
    CONSTRAINT fk_document_operation_document FOREIGN KEY (tenant_id, knowledge_space_id, document_id)
        REFERENCES knowledge_document(tenant_id, knowledge_space_id, id),
    CONSTRAINT chk_document_operation_operation
        CHECK (operation IN ('delete', 'reindex')),
    CONSTRAINT chk_document_operation_status
        CHECK (status IN ('pending', 'accepted', 'failed', 'completed')),
    CONSTRAINT chk_document_operation_key
        CHECK (btrim(idempotency_key) <> ''),
    CONSTRAINT uq_document_operation_key
        UNIQUE (tenant_id, operation, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_document_operation_document
    ON knowledge_document_operation (tenant_id, document_id, created_at DESC);

ALTER TABLE knowledge_document_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_document_operation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON knowledge_document_operation;
CREATE POLICY tenant_isolation ON knowledge_document_operation
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_document_operation TO app_rw;
