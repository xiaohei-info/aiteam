-- Manager RAG workspace -> startup instance audit projection (D21).
--
-- Endpoint and credentials remain process-local Manager startup registry data.
-- This table stores only the derived workspace and its verified instance_id; it is
-- not an endpoint or secret registry. Existing rows intentionally keep a
-- nullable instance_id as legacy data; registry-aware new workspace writes
-- stamp it before any request can route to a multi-entry pool.

ALTER TABLE rag_workspace
    ADD COLUMN IF NOT EXISTS instance_id text;

-- A malformed manual mapping must not become a routable identity. NULL is
-- retained only for legacy rows; new registry-aware writes stamp the selected
-- instance before downstream routing.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'rag_workspace'::regclass
          AND conname = 'chk_rag_workspace_instance_id'
    ) THEN
        ALTER TABLE rag_workspace
            ADD CONSTRAINT chk_rag_workspace_instance_id
            CHECK (instance_id IS NULL OR btrim(instance_id) <> '');
    END IF;
END
$$;

-- One derived workspace may belong to only one knowledge space in a tenant.
-- The existing (tenant_id, knowledge_space_id) key remains the upsert key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rag_workspace_tenant_workspace
    ON rag_workspace (tenant_id, workspace);

-- Keep tenant-scoped instance audit lookups bounded without making instance_id
-- a foreign key to the process-local registry.
CREATE INDEX IF NOT EXISTS idx_rag_workspace_tenant_instance
    ON rag_workspace (tenant_id, instance_id);
