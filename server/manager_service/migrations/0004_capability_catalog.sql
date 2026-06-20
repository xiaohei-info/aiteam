-- M4 技能/连接器/记忆策略 企业管理面目录（issue #38；04 §6.6，D17）。
-- 幂等：可重复执行（IF NOT EXISTS / DO 块）。
--
-- 设计口径（04 §6.6）：能力（技能/连接器/记忆）按「管理面 / 执行面」分开。
--   - 管理面真相在本端 Manager tenant data space：目录、可见性、安装/绑定策略、凭据授权元数据。
--   - 执行面在用户端 Agent 本地（pull 只读投影到 local_capability_cache 后本地执行）。
-- 本迁移**只落管理面真相**，不实现执行（红线①：执行态契约归用户端）。
--
-- 凭据本体（连接器/API key/Relay 令牌）**不在本卡落库**：connector_catalog 只落授权元数据
-- （谁能用的 grant），凭据本体归 M5（provider_credential / connector_credential，04 §6.7 D18）。
--
-- 隔离硬约束同 0001/0002（ENABLE + FORCE RLS、业务唯一性带 tenant_id、app_rw 受约束角色）：
--   - tenant_id 唯一来源是 TenantContext（D22），业务 SQL 不接受手写 tenant 过滤。
--   - version 单调递增，供增量 sync（F10 known_versions）与快照冻结（04 §6.3）。
--   - 记忆策略复用 mem0（OpenMemory 本地优先 MCP，D17）；本卡只存策略真相，不存记忆数据本体。

-- ---- 技能目录（tenant 作用域）----
-- skill_id：租户内技能标识（中立引用，供 employee.skills 指向）；版本与安装/绑定策略、可见性。
-- runtime 无关（D16）：不存 runtime 原生格式（SkillHub/Hermes skills 包产物归用户端本地装配）。
CREATE TABLE IF NOT EXISTS skill_catalog (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    skill_id        text NOT NULL,
    display_name    text NOT NULL DEFAULT '',
    version         text NOT NULL DEFAULT '1',
    install_policy  text NOT NULL DEFAULT 'on_demand',
    binding_policy  text NOT NULL DEFAULT 'opt_in',
    visibility      text NOT NULL DEFAULT 'private',
    config          jsonb NOT NULL DEFAULT '{}'::jsonb,
    catalog_version integer NOT NULL DEFAULT 1,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_skill_catalog_id UNIQUE (tenant_id, skill_id),
    CONSTRAINT chk_skill_install_policy CHECK (install_policy IN ('on_demand', 'pre_install', 'pinned')),
    CONSTRAINT chk_skill_binding_policy CHECK (binding_policy IN ('opt_in', 'auto_bind', 'disabled')),
    CONSTRAINT chk_skill_visibility CHECK (visibility IN ('private', 'tenant', 'public'))
);

-- ---- 连接器定义（tenant 作用域）----
-- connector_id：租户内连接器标识（中立引用，供 employee.connector_refs 指向）。
-- grant_scope：凭据授权范围元数据（谁能用——仅元数据；凭据本体归 M5）。
-- runtime 无关（D16）：连接器调用外部 SaaS 是用户端本地行为（04 §6.6），本卡不发起对外调用。
CREATE TABLE IF NOT EXISTS connector_catalog (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL,
    connector_id   text NOT NULL,
    display_name   text NOT NULL DEFAULT '',
    visibility     text NOT NULL DEFAULT 'private',
    grant_scope    text NOT NULL DEFAULT 'tenant_wide',
    config         jsonb NOT NULL DEFAULT '{}'::jsonb,
    catalog_version integer NOT NULL DEFAULT 1,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_connector_catalog_id UNIQUE (tenant_id, connector_id),
    CONSTRAINT chk_connector_visibility CHECK (visibility IN ('private', 'tenant', 'public')),
    CONSTRAINT chk_connector_grant_scope CHECK (grant_scope IN ('tenant_wide', 'department_scoped', 'member_scoped', 'disabled'))
);

-- ---- 记忆策略目录（tenant 作用域，D17）----
-- policy_id：租户内记忆策略标识（中立引用，供 employee.memory_policy 指向结构化策略）。
-- seed_memories：种子记忆（策略级，非运行时记忆数据）；retention：保留期；visibility：可见性绑定。
-- 记忆数据本体（mem0/OpenMemory 运行时记忆）在用户端 local_memory_store（04 §6.6），本卡只落策略真相。
CREATE TABLE IF NOT EXISTS memory_policy_catalog (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL,
    policy_id      text NOT NULL,
    display_name   text NOT NULL DEFAULT '',
    policy         jsonb NOT NULL DEFAULT '{}'::jsonb,
    seed_memories  jsonb NOT NULL DEFAULT '[]'::jsonb,
    retention_days integer,
    visibility     text NOT NULL DEFAULT 'private',
    config         jsonb NOT NULL DEFAULT '{}'::jsonb,
    catalog_version integer NOT NULL DEFAULT 1,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_memory_policy_catalog_id UNIQUE (tenant_id, policy_id),
    CONSTRAINT chk_memory_policy_visibility CHECK (visibility IN ('private', 'tenant', 'public')),
    CONSTRAINT chk_memory_policy_retention CHECK (retention_days IS NULL OR retention_days >= 0)
);

-- ---- version 自增触发器（同 employee 模式，供增量 sync / 快照冻结）----
CREATE OR REPLACE FUNCTION capability_catalog_touch()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.catalog_version := COALESCE(OLD.catalog_version, 0) + 1;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_skill_catalog_touch ON skill_catalog;
CREATE TRIGGER trg_skill_catalog_touch
BEFORE UPDATE OF display_name, version, install_policy, binding_policy, visibility, config
ON skill_catalog
FOR EACH ROW
EXECUTE FUNCTION capability_catalog_touch();

DROP TRIGGER IF EXISTS trg_connector_catalog_touch ON connector_catalog;
CREATE TRIGGER trg_connector_catalog_touch
BEFORE UPDATE OF display_name, visibility, grant_scope, config
ON connector_catalog
FOR EACH ROW
EXECUTE FUNCTION capability_catalog_touch();

DROP TRIGGER IF EXISTS trg_memory_policy_catalog_touch ON memory_policy_catalog;
CREATE TRIGGER trg_memory_policy_catalog_touch
BEFORE UPDATE OF display_name, policy, seed_memories, retention_days, visibility, config
ON memory_policy_catalog
FOR EACH ROW
EXECUTE FUNCTION capability_catalog_touch();

-- ---- RLS：ENABLE + FORCE + 策略 + app_rw 授权（同 0001/0002 口径）----
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['skill_catalog', 'connector_catalog', 'memory_policy_catalog']
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
