-- employee 独立绑定实体（issue AITEAM-234 / GitHub AITEAM-280）。
-- 补齐 employee_prompt_version / employee_skill_binding / employee_knowledge_binding /
-- employee_memory_setting / employee_connector_binding 五张独立绑定表。
--
-- 设计口径（04 §6.1/§6.6，D16/D20/D22）：
--   - 五表均为 employee 的**独立绑定实体**——prompt 走版本化，skill/knowledge/connector 走
--     与 catalog 的 N:1 引用绑定，memory 走单例 setting；全部以 (tenant_id, employee_id)
--     为作用域，经 Employee* Repository / Service 的 TenantContext 访问。
--   - employee 表**保留**现有中立配置列（persona/skills/knowledge_refs/connector_refs/
--     memory_policy/version）不变——M7 EmployeeExecutionSnapshot 仍从 EmployeeConfigService
--     派生；本迁移只做加法，不拆改现有 EmployeeConfigService/SnapshotService（守红线：
--     不破坏已冻结的快照契约，04 §6.3 D5）。
--   - tenant_id 唯一来源是 TenantContext（D22），业务 SQL 不接受手写 tenant 过滤。
--   - RLS：ENABLE + FORCE + 策略基于 current_setting('app.tenant_id')，app_rw 读写。
--
-- 幂等：可重复执行（IF NOT EXISTS / CREATE POLICY 前先 DROP / 去掉触发器 IF EXISTS）。

-- ========== 1. employee_prompt_version ==========
-- employee 的 prompt 版本化实体。每个 employee 可有多个 prompt 版本（含 persona/model/provider/
-- thinking/tools），只有一个"当前生效版"（is_current）。版本号单调递增；回滚 = 重建旧版记录。
CREATE TABLE IF NOT EXISTS employee_prompt_version (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    employee_id     uuid NOT NULL,
    version         integer NOT NULL,
    display_name    text NOT NULL DEFAULT '',
    persona         text,
    model           text,
    provider_ref    text,
    thinking_level  text,
    tools           jsonb NOT NULL DEFAULT '[]'::jsonb,
    is_current      boolean NOT NULL DEFAULT false,
    change_note     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_emp_prompt_emp FOREIGN KEY (employee_id) REFERENCES employee(id) ON DELETE CASCADE,
    CONSTRAINT uq_emp_prompt_ver UNIQUE (tenant_id, employee_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_emp_prompt_current
    ON employee_prompt_version (tenant_id, employee_id) WHERE is_current;

-- ========== 2. employee_skill_binding ==========
-- employee ↔ skill_catalog(skill_id) 的 N:1 引用绑定；enabled 控制是否生效，config 放级联参数。
CREATE TABLE IF NOT EXISTS employee_skill_binding (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    employee_id     uuid NOT NULL,
    skill_id        text NOT NULL,
    enabled         boolean NOT NULL DEFAULT true,
    config          jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_emp_skill_emp FOREIGN KEY (employee_id) REFERENCES employee(id) ON DELETE CASCADE,
    CONSTRAINT uq_emp_skill UNIQUE (tenant_id, employee_id, skill_id)
);

-- ========== 3. employee_knowledge_binding ==========
-- employee ↔ knowledge_space(knowledge_space_id) 的 N:1 引用绑定。
CREATE TABLE IF NOT EXISTS employee_knowledge_binding (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL,
    employee_id          uuid NOT NULL,
    knowledge_space_id   text NOT NULL,
    enabled              boolean NOT NULL DEFAULT true,
    config               jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_emp_know_emp FOREIGN KEY (employee_id) REFERENCES employee(id) ON DELETE CASCADE,
    CONSTRAINT uq_emp_know UNIQUE (tenant_id, employee_id, knowledge_space_id)
);

-- ========== 4. employee_memory_setting ==========
-- employee 记忆策略单例 setting（与 employee 1:1，但以独立实体持存，便于后续扩字段）。
CREATE TABLE IF NOT EXISTS employee_memory_setting (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    employee_id     uuid NOT NULL,
    policy          jsonb NOT NULL DEFAULT '{}'::jsonb,
    seed_memories   jsonb NOT NULL DEFAULT '[]'::jsonb,
    retention_days  integer,
    scope           text NOT NULL DEFAULT 'tenant',
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_emp_memory_emp FOREIGN KEY (employee_id) REFERENCES employee(id) ON DELETE CASCADE,
    CONSTRAINT uq_emp_memory UNIQUE (tenant_id, employee_id)
);

-- ========== 5. employee_connector_binding ==========
-- employee ↔ connector_catalog(connector_id) 的 N:1 引用绑定；grant_ref 指向 M5 provider_credential。
CREATE TABLE IF NOT EXISTS employee_connector_binding (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    employee_id     uuid NOT NULL,
    connector_id    text NOT NULL,
    grant_ref       text,
    enabled         boolean NOT NULL DEFAULT true,
    config          jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_emp_conn_emp FOREIGN KEY (employee_id) REFERENCES employee(id) ON DELETE CASCADE,
    CONSTRAINT uq_emp_conn UNIQUE (tenant_id, employee_id, connector_id)
);

-- ========== RLS：ENABLE + FORCE + 策略（基于 current_setting('app.tenant_id')）+ app_rw 授权 ==========
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'employee_prompt_version',
        'employee_skill_binding',
        'employee_knowledge_binding',
        'employee_memory_setting',
        'employee_connector_binding'
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
END $$;
