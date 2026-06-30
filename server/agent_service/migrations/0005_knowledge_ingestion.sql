-- Agent 知识库文档摄入流程（AITEAM-260 / GitHub #310）。
-- 为 KnowledgeDocument 补齐 updated_at / ingestion_job_id / status 状态机字段，并新增 KnowledgeIngestions 表。

ALTER TABLE knowledge_documents ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_documents ADD COLUMN status TEXT NOT NULL DEFAULT 'uploaded';
ALTER TABLE knowledge_documents ADD COLUMN ingestion_job_id TEXT;
ALTER TABLE knowledge_documents ADD COLUMN rag_document_id TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_documents ADD COLUMN error_code TEXT;
ALTER TABLE knowledge_documents ADD COLUMN error_message TEXT;
ALTER TABLE knowledge_documents ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_documents ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'file';
ALTER TABLE knowledge_documents ADD COLUMN source_url TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS knowledge_ingestions (
    job_id          TEXT PRIMARY KEY,
    kb_id           TEXT NOT NULL REFERENCES knowledge_bases(kb_id),
    document_id     TEXT NOT NULL REFERENCES knowledge_documents(doc_id),
    status          TEXT NOT NULL DEFAULT 'pending',
    rag_document_id TEXT NOT NULL DEFAULT '',
    error_message   TEXT,
    chunk_count     INTEGER NOT NULL DEFAULT 0,
    started_at      TEXT,
    completed_at    TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingestions_kb ON knowledge_ingestions (kb_id);
CREATE INDEX IF NOT EXISTS idx_ingestions_doc ON knowledge_ingestions (document_id);
