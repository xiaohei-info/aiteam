-- provider 凭据 / AI Relay 管理（M5，04 §6.7，D18）。
-- 幂等：可重复执行（IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DO 块）。
--
-- 设计口径（04 §6.7，D18）：
--   - 管理面存 provider 接入配置真相：默认 AI Relay 端点 + 企业级令牌；或（可选）直连 provider 凭据（API key）。
--   - 明文凭据入库前加密（应用层 cryptography.Fernet；密钥来源 settings/env，不入库不日志）。
--   - 对外只给 provider_ref + 非敏感元数据（endpoint/可见性），绝不下发明文 key/令牌。
--   - Employee snapshot 以 provider_ref 引用该配置，不内联明文凭据。
--   - 本地最小注入：用户端按授权拉取 provider 元数据并由 Pi ModelRuntime 解析凭据。
--
-- 隔离硬约束（04 §6.1.1）：本表为租户作用域，ENABLE + FORCE ROW LEVEL SECURITY；
--   tenant_id 唯一来源是 TenantContext（D22），业务 SQL 不接受手写 tenant 过滤。

CREATE TABLE IF NOT EXISTS provider_credential (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL,
    provider_ref      text NOT NULL,
    display_name      text NOT NULL DEFAULT '',
    -- mode：relay（默认，企业级令牌走 AI Relay）| direct（可选，直连 provider API key）。
    mode              text NOT NULL DEFAULT 'relay',
    -- endpoint：AI Relay 或直连 provider 的接入端点（非敏感，回显允许）。
    endpoint          text,
    -- encrypted_secret：明文凭据经 Fernet 加密后的 token（bytea），绝不下发明文。
    encrypted_secret  bytea NOT NULL,
    -- 可见性：tenant（租户内全员可用）| members（仅 allowed_member_ids 列出的成员）。
    visibility        text NOT NULL DEFAULT 'tenant',
    -- 成员级授权真相态：visibility=members 时生效（app_user.id 列表）。
    allowed_member_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    version           integer NOT NULL DEFAULT 1,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_provider_ref UNIQUE (tenant_id, provider_ref),
    CONSTRAINT chk_provider_mode CHECK (mode IN ('relay', 'direct')),
    CONSTRAINT chk_provider_visibility CHECK (visibility IN ('tenant', 'members'))
);

-- 配置变更时刷新 updated_at + version（供增量 sync 与并发控制，02 §10.3.6）。
CREATE OR REPLACE FUNCTION provider_credential_touch()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.version := COALESCE(OLD.version, 0) + 1;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_provider_credential_touch ON provider_credential;
CREATE TRIGGER trg_provider_credential_touch
BEFORE UPDATE OF display_name, mode, endpoint, encrypted_secret,
                 visibility, allowed_member_ids
ON provider_credential
FOR EACH ROW
EXECUTE FUNCTION provider_credential_touch();

-- ---- RLS：ENABLE + FORCE + 策略（对齐 0001_tenant_base.sql 既有范式）----
DO $$
BEGIN
    ALTER TABLE provider_credential ENABLE ROW LEVEL SECURITY;
    ALTER TABLE provider_credential FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON provider_credential;
    CREATE POLICY tenant_isolation ON provider_credential
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
    GRANT SELECT, INSERT, UPDATE, DELETE ON provider_credential TO app_rw;
END
$$;
