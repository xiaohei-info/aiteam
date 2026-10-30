-- 企业知识库部署位置（议题 6：企业 / 个人 / 本机三分；企业 NAS 经 Manager 网关）。
-- 幂等：可重复执行（IF NOT EXISTS / DO 块）。
--
-- 设计口径：
--   - 部署位置是企业知识库的属性：managed = Manager 托管（LightRAG），nas = 企业内网 NAS。
--     无行即 managed，既有租户无需回填。
--   - endpoint / credential_ref 仅 kind=nas 时存在；credential_ref 只是 Manager 进程环境变量名，
--     凭据值从不入库，也不返回给普通成员（仅 owner/enterprise_admin 可读该引用名）。
--   - 本表由 Manager 单写；tenant_id 唯一来源是 TenantContext（D22），RLS 同 0001/0003。

CREATE TABLE IF NOT EXISTS knowledge_space_deployment (
    tenant_id          uuid NOT NULL,
    knowledge_space_id text NOT NULL,
    kind               text NOT NULL DEFAULT 'managed',
    endpoint           text,
    credential_ref     text,
    updated_by         text NOT NULL DEFAULT '',
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_knowledge_space_deployment PRIMARY KEY (tenant_id, knowledge_space_id),
    CONSTRAINT chk_knowledge_space_deployment_kind CHECK (kind IN ('managed', 'nas')),
    CONSTRAINT chk_knowledge_space_deployment_nas CHECK (
        (kind = 'managed' AND endpoint IS NULL AND credential_ref IS NULL)
        OR (kind = 'nas' AND btrim(coalesce(endpoint, '')) <> '' AND btrim(coalesce(credential_ref, '')) <> '')
    )
);

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['knowledge_space_deployment']
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
