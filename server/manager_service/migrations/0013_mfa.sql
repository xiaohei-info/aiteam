-- Manager 多因素认证（MFA）：passkey / oauth / 登录审计 / 密码策略（issue AITEAM-253 / GitHub #299）。
-- 幂等：可重复执行（IF NOT EXISTS / DO 块）。
--
-- 设计口径（03 §9.3，04 §6.1.1 D22/D23）：
--   - 登录方式多样性只活在 Authenticator 一层；passkey / oauth 是新 AuthProvider 取值，
--     映射到 auth_identity 行（provider=passkey|oauth, external_id=凭据/三方身份 id）。
--   - 所有表强制 RLS；tenant_id 只从 TenantContext 取，业务 SQL 不接受手写 tenant 过滤（D22）。
--   - login_attempt 登录审计：企图即记（成功/失败、provider、账号域、脱敏 ip），不含密码/token 明文。
--   - passkey_credential 存 WebAuthn 公钥凭据；challenge 只存活 TTL，不落库。
--   - oauth_connection 存三方身份→内部 user 的绑定与脱敏 profile；**不存 access/refresh 明文 token**（Manager
--     是身份源，签发自有 JWT；OAuth 登录为一次性校验，凭据来源端持有 token）。
--
-- 隔离硬约束（D22）：tenant_id 唯一来源是 TenantContext。

-- ---- auth_identity：密码策略年龄（过期用） ----
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'auth_identity' AND column_name = 'password_changed_at') THEN
        ALTER TABLE auth_identity ADD COLUMN password_changed_at timestamptz;
    END IF;
    -- 回填已有行（密码创建时间即入职时间，首次落库改 migration 时间）。
    UPDATE auth_identity SET password_changed_at = COALESCE(password_changed_at, created_at)
        WHERE password_changed_at IS NULL AND secret IS NOT NULL;
END
$$;

-- ---- 登录审计 ----
CREATE TABLE IF NOT EXISTS login_attempt (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL,
    actor        text NOT NULL,           -- member_id / 'anon'（失败且未能定位身份时为 anon）
    provider     text NOT NULL,           -- AuthProvider 取值（passkey/oauth/password/phone）
    external_id  text,                    -- 登录账号域（手机号/credential_id/三方 sub），可空
    ip_hash      text NOT NULL,           -- 客户端 ip 的 SHA-256（脱敏，仅用于频率/追溯，不存明文 ip）
    success      boolean NOT NULL,
    detail       text,                    -- 脱敏摘要（fail 原因类别 / success 时的 credential 标签）
    occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_login_attempt_tenant_time
    ON login_attempt (tenant_id, occurred_at DESC);

-- ---- Passkey（WebAuthn）凭据 ----
CREATE TABLE IF NOT EXISTS passkey_credential (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL,
    user_id        uuid NOT NULL,
    credential_id  text NOT NULL,          -- base64url 凭据 id（unique per tenant）
    public_key_pem text NOT NULL,          -- 公钥（PEM），校验签名用
    sign_count     integer NOT NULL DEFAULT 0,
    label          text NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_used_at   timestamptz,
    CONSTRAINT uq_passkey_credential UNIQUE (tenant_id, credential_id)
);

CREATE INDEX IF NOT EXISTS ix_passkey_credential_user
    ON passkey_credential (tenant_id, user_id);

-- ---- OAuth 三方身份绑定 ----
CREATE TABLE IF NOT EXISTS oauth_connection (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    user_id          uuid NOT NULL,
    provider         text NOT NULL,         -- google / github …
    provider_user_id text NOT NULL,         -- 三方主体 id（sub）
    profile_email    text,
    connected_at     timestamptz NOT NULL DEFAULT now(),
    last_login_at    timestamptz,
    CONSTRAINT uq_oauth_connection UNIQUE (tenant_id, provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS ix_oauth_connection_user
    ON oauth_connection (tenant_id, user_id);

-- ---- RLS ----
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['login_attempt', 'passkey_credential', 'oauth_connection']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
            'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
            t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO app_rw', t);
    END LOOP;
END
$$;
