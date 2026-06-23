-- Operation 企业账号表（oper 库，单写者：Operator）。
-- 幂等：可重复执行（IF NOT EXISTS / OR REPLACE / DO 块）。
--
-- 边界（CLAUDE/AGENTS §3.2）：
--   - 企业账号表唯一写端是 Operator（单写者）。
--   - 只持「企业账号 + 负责人 bootstrap 校验材料(hash/一次性)」。
--   - Operator 永不持企业长期密码（03 §9.2）。
--   - owner_bootstrap_hash 只存校验材料（sha256），绝不存长期/明文密码。
--
-- oper 库是 Operation 专属单租户库，无 RLS（不同于 Manager 的多租户 RLS）。
-- 但仍采用业界规范：应用角色非 superuser、迁移/DDL 用独立管理连接。

-- ---- 应用角色：非 superuser、非 BYPASSRLS（规范，虽 oper 库无 RLS）----
-- 与 Manager 对齐：业务连接以受约束角色登录，保持形式一致性。
-- LOGIN 口令不硬编码进迁移脚本：由迁移执行器从配置/env 取口令，
-- 在管理连接内幂等 `ALTER ROLE app_rw WITH LOGIN PASSWORD ...` 下发。
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
        CREATE ROLE app_rw LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    ELSE
        ALTER ROLE app_rw LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
END
$$;

-- 业务连接以 app_rw 身份建连后需要 connect 到本库 + 用 public schema。
GRANT CONNECT ON DATABASE oper TO app_rw;
GRANT USAGE ON SCHEMA public TO app_rw;

-- 扩展：gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- 企业账号表 ----
CREATE TABLE IF NOT EXISTS enterprise_account (
    enterprise_id       uuid PRIMARY KEY,
    tenant_id           uuid NOT NULL UNIQUE,
    enterprise_name     text NOT NULL,
    enterprise_code     text,
    owner_phone         text NOT NULL,
    owner_bootstrap_hash text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    -- 业务唯一性：enterprise_code 非空时全局唯一（可选字段）。
    CONSTRAINT uq_enterprise_code UNIQUE NULLS NOT DISTINCT (enterprise_code)
);

-- 索引：按 tenant_id 查询（跨端对照用）。
CREATE INDEX IF NOT EXISTS idx_enterprise_account_tenant ON enterprise_account(tenant_id);

-- 索引：按 enterprise_code 查询（开通验重用）。
CREATE INDEX IF NOT EXISTS idx_enterprise_account_code ON enterprise_account(enterprise_code)
    WHERE enterprise_code IS NOT NULL;

-- 应用角色读写权限。
GRANT SELECT, INSERT, UPDATE, DELETE ON enterprise_account TO app_rw;
