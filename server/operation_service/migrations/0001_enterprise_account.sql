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
-- Dev 环境复用 aiteam_v1 库，生产应独立 oper 库（CLAUDE §3.2）。
-- GRANT CONNECT 需要数据库名，但迁移脚本内无法动态获取当前库名，
-- 故由外层迁移执行器单独处理（或手动授权）。此处注释保留口径。
-- GRANT CONNECT ON DATABASE oper TO app_rw;
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
    -- 业务唯一性：enterprise_code 非空时全局唯一（可选字段）。默认 NULLS DISTINCT：
    -- 多个未填 code 的企业（NULL）互不相撞；仅非空 code 强制唯一。
    -- （原 NULLS NOT DISTINCT 会让多个 NULL 视为相等 → 开通第二家不填 code 的企业 409。）
    CONSTRAINT uq_enterprise_code UNIQUE (enterprise_code)
);

-- 历史修正（幂等）：既有库若带 NULLS NOT DISTINCT 版本的约束，就地重建为默认 NULLS DISTINCT。
DO $$
BEGIN
    IF EXISTS (
        -- NULLS NOT DISTINCT 记在底层唯一索引上（pg_index.indnullsnotdistinct，PG15+），
        -- 不在 pg_constraint；经 conindid 关联到索引判定。
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_index i ON i.indexrelid = c.conindid
        WHERE t.relname = 'enterprise_account'
          AND c.conname = 'uq_enterprise_code'
          AND i.indnullsnotdistinct
    ) THEN
        ALTER TABLE enterprise_account DROP CONSTRAINT uq_enterprise_code;
        ALTER TABLE enterprise_account ADD CONSTRAINT uq_enterprise_code UNIQUE (enterprise_code);
    END IF;
END
$$;

-- 索引：按 tenant_id 查询（跨端对照用）。
CREATE INDEX IF NOT EXISTS idx_enterprise_account_tenant ON enterprise_account(tenant_id);

-- 索引：按 enterprise_code 查询（开通验重用）。
CREATE INDEX IF NOT EXISTS idx_enterprise_account_code ON enterprise_account(enterprise_code)
    WHERE enterprise_code IS NOT NULL;

-- 应用角色读写权限。
GRANT SELECT, INSERT, UPDATE, DELETE ON enterprise_account TO app_rw;
