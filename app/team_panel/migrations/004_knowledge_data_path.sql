-- 004_knowledge_data_path: P08 knowledge docs / ingestion / retrieval state

CREATE TABLE IF NOT EXISTS knowledge_base (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','archived')),
    document_count INTEGER NOT NULL DEFAULT 0,
    storage_prefix TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_kb_enterprise_name
    ON knowledge_base(enterprise_id, name);
CREATE INDEX IF NOT EXISTS idx_kb_enterprise_status
    ON knowledge_base(enterprise_id, status);

ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS document_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS storage_prefix TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS knowledge_document (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_base(id),
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    asset_id TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL DEFAULT '',
    file_type TEXT NOT NULL DEFAULT '',
    file_size BIGINT NOT NULL DEFAULT 0,
    storage_key TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'uploaded'
        CHECK(status IN ('uploaded','ingesting','ready','error')),
    ingestion_job_id TEXT,
    rag_document_id TEXT NOT NULL DEFAULT '',
    error_code TEXT,
    error_message TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
ALTER TABLE knowledge_document ADD COLUMN IF NOT EXISTS enterprise_id TEXT REFERENCES enterprise(id);
ALTER TABLE knowledge_document ADD COLUMN IF NOT EXISTS file_name TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_document ADD COLUMN IF NOT EXISTS file_size BIGINT NOT NULL DEFAULT 0;
ALTER TABLE knowledge_document ADD COLUMN IF NOT EXISTS storage_key TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_document ADD COLUMN IF NOT EXISTS rag_document_id TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_document ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE knowledge_document ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE knowledge_document ADD COLUMN IF NOT EXISTS chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_document ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE knowledge_document ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE knowledge_document ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'knowledge_document' AND column_name = 'file_size_bytes'
    ) THEN
        EXECUTE 'UPDATE knowledge_document SET file_size = COALESCE(NULLIF(file_size, 0), file_size_bytes)';
    END IF;
END $$;

UPDATE knowledge_document kd
SET enterprise_id = kb.enterprise_id
FROM knowledge_base kb
WHERE kd.knowledge_base_id = kb.id
  AND kd.enterprise_id IS NULL;

UPDATE knowledge_document
SET status = CASE
    WHEN status IN ('parsing', 'indexing') THEN 'ingesting'
    WHEN status = 'failed' THEN 'error'
    ELSE status
END
WHERE status IN ('parsing', 'indexing', 'failed');

UPDATE knowledge_document
SET file_name = COALESCE(NULLIF(file_name, ''), display_name)
WHERE file_name = '';

ALTER TABLE knowledge_document DROP CONSTRAINT IF EXISTS knowledge_document_status_check;
ALTER TABLE knowledge_document
    ADD CONSTRAINT knowledge_document_status_check
    CHECK(status IN ('uploaded','ingesting','ready','error'));

CREATE INDEX IF NOT EXISTS idx_kd_kb_id ON knowledge_document(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_kd_kb_status ON knowledge_document(knowledge_base_id, status);
CREATE INDEX IF NOT EXISTS idx_kd_enterprise_kb ON knowledge_document(enterprise_id, knowledge_base_id);
CREATE UNIQUE INDEX IF NOT EXISTS uk_kd_kb_asset
    ON knowledge_document(knowledge_base_id, asset_id) WHERE asset_id != '';
CREATE UNIQUE INDEX IF NOT EXISTS uk_kd_rag_document_id
    ON knowledge_document(rag_document_id) WHERE rag_document_id != '';

CREATE TABLE IF NOT EXISTS knowledge_ingestion_job (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_base(id),
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    document_id TEXT NOT NULL REFERENCES knowledge_document(id),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','parsing','inserting','completed','failed')),
    rag_document_id TEXT NOT NULL DEFAULT '',
    error_message TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_kij_document ON knowledge_ingestion_job(document_id);
CREATE INDEX IF NOT EXISTS idx_kij_kb_status ON knowledge_ingestion_job(knowledge_base_id, status);
CREATE INDEX IF NOT EXISTS idx_kij_status_created ON knowledge_ingestion_job(status, created_at);

ALTER TABLE knowledge_ingestion_job ADD COLUMN IF NOT EXISTS enterprise_id TEXT REFERENCES enterprise(id);
ALTER TABLE knowledge_ingestion_job ADD COLUMN IF NOT EXISTS rag_document_id TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_ingestion_job ADD COLUMN IF NOT EXISTS chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_ingestion_job ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE knowledge_ingestion_job ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE knowledge_ingestion_job ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE knowledge_ingestion_job ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'knowledge_ingestion_job' AND column_name = 'finished_at'
    ) THEN
        EXECUTE 'UPDATE knowledge_ingestion_job SET completed_at = COALESCE(completed_at, finished_at)';
    END IF;
END $$;

UPDATE knowledge_ingestion_job kij
SET enterprise_id = kb.enterprise_id
FROM knowledge_base kb
WHERE kij.knowledge_base_id = kb.id
  AND kij.enterprise_id IS NULL;

UPDATE knowledge_ingestion_job
SET status = CASE
    WHEN status = 'queued' THEN 'pending'
    WHEN status = 'running' THEN 'parsing'
    WHEN status = 'succeeded' THEN 'completed'
    ELSE status
END
WHERE status IN ('queued', 'running', 'succeeded');

ALTER TABLE knowledge_ingestion_job DROP CONSTRAINT IF EXISTS knowledge_ingestion_job_status_check;
ALTER TABLE knowledge_ingestion_job
    ADD CONSTRAINT knowledge_ingestion_job_status_check
    CHECK(status IN ('pending','parsing','inserting','completed','failed'));

CREATE TABLE IF NOT EXISTS knowledge_index_binding (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    employee_id TEXT NOT NULL REFERENCES employee(id),
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_base(id),
    employee_knowledge_binding_id TEXT REFERENCES employee_knowledge_binding(id),
    document_id TEXT REFERENCES knowledge_document(id),
    rag_index_id TEXT NOT NULL,
    rag_document_id TEXT NOT NULL DEFAULT '',
    scope_mode TEXT NOT NULL DEFAULT 'read'
        CHECK(scope_mode IN ('read','read_write_metadata')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','ready','error','disabled')),
    error_message TEXT,
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_kib_employee_rag_index
    ON knowledge_index_binding(employee_id, knowledge_base_id, rag_index_id)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_kib_employee_status
    ON knowledge_index_binding(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_kib_document_status
    ON knowledge_index_binding(document_id, status);
CREATE INDEX IF NOT EXISTS idx_kib_binding_status
    ON knowledge_index_binding(employee_knowledge_binding_id, status);
