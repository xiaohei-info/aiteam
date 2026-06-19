-- Manager 多租户底座（04 §6.1.1/§6.1.2/§6.1.3，D20/D21/D22）。
-- 幂等：可重复执行（IF NOT EXISTS / OR REPLACE / DO 块）。
--
-- 隔离硬约束（04 §6.1.1）：
--   3. 租户表 ENABLE + FORCE ROW LEVEL SECURITY（表 owner 也受策略约束）。
--   4. 每请求事务内 SET LOCAL app.tenant_id。
--   5. 应用 DB 角色非 superuser、非 BYPASSRLS（这里用 app_rw，应用连接 SET LOCAL ROLE app_rw）。
--   2. 业务唯一性带 tenant_id（unique(tenant_id, ...)）。

-- ---- 应用角色：非 superuser、非 BYPASSRLS、非表 owner（否则绕过 RLS）----
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
        CREATE ROLE app_rw NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
END
$$;

-- 扩展：gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- 控制面表（manager_control_db，无 RLS，平台托管）----
CREATE TABLE IF NOT EXISTS tenant_registry (
    tenant_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_slug text NOT NULL UNIQUE,
    enterprise_code text,
    isolation_level text NOT NULL DEFAULT 'l1_shared_rls',
    status          text NOT NULL DEFAULT 'active',
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- 按 tenant 持签名私钥（D23）。控制面表，私钥仅 Manager 持有，绝不下发用户端；
-- 用户端只领 JWKS（公钥）。app_rw 不授任何权限（业务连接拿不到私钥）。
CREATE TABLE IF NOT EXISTS tenant_signing_key (
    tenant_id    uuid PRIMARY KEY,
    kid          text NOT NULL,
    private_pem  text NOT NULL,
    public_pem   text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---- 租户作用域表（强制 RLS）----

-- 规范账号 principal（03 §9.3）。Manager 内必带 tenant_id。
CREATE TABLE IF NOT EXISTS app_user (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    enterprise_id uuid,
    display_name  text NOT NULL DEFAULT '',
    status        text NOT NULL DEFAULT 'active',
    roles         text[] NOT NULL DEFAULT '{}',
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- 外部身份 → 内部 user（03 §9.3）。unique(tenant_id, provider, external_id)。
CREATE TABLE IF NOT EXISTS auth_identity (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    user_id     uuid NOT NULL,
    provider    text NOT NULL,
    external_id text NOT NULL,
    secret      text,
    must_reset  boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_auth_identity UNIQUE (tenant_id, provider, external_id)
);

-- RAG workspace 映射（04 §6.1.2 第 6 条：workspace/tenant 映射落可审计 PG 层 + RLS 第二防线）。
CREATE TABLE IF NOT EXISTS rag_workspace (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL,
    knowledge_space_id text NOT NULL,
    workspace          text NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_rag_workspace UNIQUE (tenant_id, knowledge_space_id)
);

-- 演示业务表：跨租户隔离回归靶子（04 §6.1.3 要求 DB 之外亦测，这里先守 DB RLS）。
CREATE TABLE IF NOT EXISTS employee (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    employee_slug text NOT NULL,
    display_name  text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_employee_slug UNIQUE (tenant_id, employee_slug)
);

-- ---- RLS：ENABLE + FORCE + 策略（基于 current_setting('app.tenant_id', true)）----
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['app_user', 'auth_identity', 'rag_workspace', 'employee']
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
        -- 应用角色读写权限（非 owner，受 RLS 约束）。
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_rw', t);
    END LOOP;
END
$$;

-- 控制面表对 app_rw 只读（tenant 路由查 isolation_level 等用）。
GRANT SELECT ON tenant_registry TO app_rw;
