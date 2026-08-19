-- M4 企业端知识库文档 intake 生命周期 + 索引绑定（issue #416，04 §6.1.2/§6.6；D21/D22）。
-- 幂等：可重复执行（IF NOT EXISTS / DO 块 / ADD COLUMN IF NOT EXISTS）。
--
-- 设计口径：
--   - knowledge_space 是知识容器（M3 已建立 rag_workspace + knowledge_space_binding）；本迁移在
--     其下新增文档级 intake 实体 + intake 任务跟踪 + 索引绑定传播，不新建 KB 概念。
--   - 文档状态机：uploaded → parsing → indexing → ready | failed。
--   - 索引绑定完成态走 knowledge_document_binding（employee ↔ document，含 rag_document_id）。
--     Manager 通过受控 LightRAG ingestion client 写入，rag_document_id 为稳定 file_source/source alias。
--   - tenant_id 唯一来源是 TenantContext（D22），业务 SQL 不接受手写 tenant 过滤。
--   - RLS：ENABLE + FORCE + 策略基于 current_setting('app.tenant_id')，app_rw 读写。
--
-- 隔离硬约束同 0001/0003：业务唯一性带 tenant_id、外键级联清残。

-- ========== 1. knowledge_document（文档级实体，挂到 knowledge_space 下）==========
-- source_type: file | url  （file = 上传；url = URL 导入）。
-- status: uploaded | parsing | indexing | ready | failed。
-- 文件本体经对象存储/本地卷落盘（storage_key）；解析后文本长度 text_chars 仅做审计。
CREATE TABLE IF NOT EXISTS knowledge_document (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL,
    knowledge_space_id   text NOT NULL,
    display_name         text NOT NULL,
    source_type          text NOT NULL,
    file_name            text NOT NULL DEFAULT '',
    file_type            text NOT NULL DEFAULT '',
    file_size            bigint NOT NULL DEFAULT 0,
    storage_key          text NOT NULL DEFAULT '',
    status               text NOT NULL DEFAULT 'uploaded',
    text_chars           integer,
    error_code           text,
    error_message        text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_knowledge_document UNIQUE (tenant_id, knowledge_space_id, id),
    CONSTRAINT chk_knowledge_document_source CHECK (source_type IN ('file', 'url')),
    CONSTRAINT chk_knowledge_document_status CHECK (status IN ('uploaded', 'parsing', 'indexing', 'ready', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_document_space_status
    ON knowledge_document (tenant_id, knowledge_space_id, status);

-- ========== 2. knowledge_ingestion_job（intake 任务跟踪）==========
-- 一个文档可有多次 intake 任务（retry 创建新 job）。status: parsing | indexing | done | failed。
CREATE TABLE IF NOT EXISTS knowledge_ingestion_job (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL,
    knowledge_space_id   text NOT NULL,
    document_id          uuid NOT NULL,
    status               text NOT NULL DEFAULT 'parsing',
    error_code           text,
    error_message        text,
    chunk_count          integer,
    started_at           timestamptz,
    completed_at         timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_ingestion_document FOREIGN KEY (document_id)
        REFERENCES knowledge_document(id) ON DELETE CASCADE,
    CONSTRAINT chk_ingestion_status CHECK (status IN ('parsing', 'indexing', 'done', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_ingestion_document
    ON knowledge_ingestion_job (tenant_id, document_id, created_at DESC);

-- ========== 3. knowledge_document_binding（employee ↔ document 索引绑定传播） ==========
-- intake 完成后，向 knowledge_space 已绑员工传播索引绑定（D21 下的 index binding 视图）。
-- 真相态归 employee_knowledge_binding（D21）；本表为检索侧服务。
CREATE TABLE IF NOT EXISTS knowledge_document_binding (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 uuid NOT NULL,
    knowledge_space_id        text NOT NULL,
    document_id               uuid NOT NULL,
    employee_id               uuid NOT NULL,
    rag_document_id           text,
    status                    text NOT NULL DEFAULT 'pending',
    last_synced_at            timestamptz,
    created_at                timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_binding_document FOREIGN KEY (document_id)
        REFERENCES knowledge_document(id) ON DELETE CASCADE,
    CONSTRAINT uq_binding_doc_emp UNIQUE (tenant_id, document_id, employee_id),
    CONSTRAINT chk_binding_status CHECK (status IN ('pending', 'ready', 'stale'))
);
CREATE INDEX IF NOT EXISTS idx_binding_employee
    ON knowledge_document_binding (tenant_id, employee_id, status);

-- ========== RLS：ENABLE + FORCE + 策略 + app_rw 授权 ==========
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'knowledge_document',
        'knowledge_ingestion_job',
        'knowledge_document_binding'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
            'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
            t
        );
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_rw', t);
    END LOOP;
END
$$;
