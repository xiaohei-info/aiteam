-- M3 知识库/RAG 管理面（04 §6.1.2/§6.6；05 F08；D21）。
-- 幂等：可重复执行（IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DO 块）。
--
-- 设计口径（04 §6.1.2，D21）：
--   - workspace 只能由 ManagerRagService 从 TenantContext 推导（tenant_id + knowledge_space_id），
--     前端/Agent/业务 API 不得直传 workspace（D21）。
--   - rag_workspace 表已存在于 0001（workspace/tenant 映射 + RLS 第二防线）；本迁移仅扩列
--     display_name（知识空间管理面展示名），不动隔离策略。
--   - knowledge_space_binding：知识空间 → 部门/成员 的绑定真相态（仅绑定元数据，不做检索执行；
--     专家绑定真相态走 employee_knowledge_binding，本表只落部门/成员绑定）。
--
-- 隔离硬约束同 0001：ENABLE + FORCE RLS、业务唯一性带 tenant_id、app_rw 受约束角色。
--   - tenant_id 唯一来源是 TenantContext（D22），业务 SQL 不接受手写 tenant 过滤。

-- ---- rag_workspace 扩列：知识空间管理面展示名 ----
-- 默认空串，向后兼容既有 INSERT（0001 未带 display_name 的行取默认值）。
ALTER TABLE rag_workspace ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';

-- ---- 知识空间绑定（tenant 作用域，D21）----
-- resource_type: department | member（专家绑定真相态走 employee_knowledge_binding，不入本表）。
-- resource_id: 部门 id 或成员 id（均为 uuid）。
-- unique(tenant_id, knowledge_space_id, resource_type, resource_id) 防重复绑定。
CREATE TABLE IF NOT EXISTS knowledge_space_binding (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL,
    knowledge_space_id text NOT NULL,
    resource_type      text NOT NULL,
    resource_id        uuid NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_knowledge_space_binding UNIQUE (tenant_id, knowledge_space_id, resource_type, resource_id),
    CONSTRAINT chk_knowledge_space_binding_resource CHECK (resource_type IN ('department', 'member'))
);

-- ---- RLS：ENABLE + FORCE + 策略 + app_rw 授权（同 0001/0002 口径）----
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['knowledge_space_binding']
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
