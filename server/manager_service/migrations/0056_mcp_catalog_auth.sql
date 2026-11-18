-- 0056: 企业 MCP 目录鉴权字段（设计 2026-11-18 MCP鉴权与配置导入 §3.8 / §3.10）。幂等：每次部署都会重跑。
-- requires_credentials(bool) → auth(none|oauth|bearer)：旧 true 视为 bearer。需鉴权的条目也进入成员可装列表，
-- 凭据由成员本机自行登录 / 填写，企业端永不保存成员令牌。
-- 平台预登记的 OAuth 应用密钥由 Operator 服务间下发，企业端用自己的密钥（MANAGER_CREDENTIAL_KEY）重新加密保存。

ALTER TABLE mcp_catalog ADD COLUMN IF NOT EXISTS auth text NOT NULL DEFAULT 'none';
ALTER TABLE mcp_catalog ADD COLUMN IF NOT EXISTS auth_header text NOT NULL DEFAULT '';
ALTER TABLE mcp_catalog ADD COLUMN IF NOT EXISTS oauth_scopes text NOT NULL DEFAULT '';
ALTER TABLE mcp_catalog ADD COLUMN IF NOT EXISTS timeout_ms integer NOT NULL DEFAULT 30000;
ALTER TABLE mcp_catalog ADD COLUMN IF NOT EXISTS oauth_client_id text NOT NULL DEFAULT '';
ALTER TABLE mcp_catalog ADD COLUMN IF NOT EXISTS oauth_client_secret_enc bytea;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'mcp_catalog' AND column_name = 'requires_credentials'
    ) THEN
        UPDATE mcp_catalog SET auth = 'bearer' WHERE requires_credentials AND auth = 'none';
        ALTER TABLE mcp_catalog DROP COLUMN requires_credentials;
    END IF;
END $$;

ALTER TABLE mcp_catalog DROP CONSTRAINT IF EXISTS chk_mcp_catalog_auth;
ALTER TABLE mcp_catalog ADD CONSTRAINT chk_mcp_catalog_auth CHECK (auth IN ('none', 'oauth', 'bearer'));
ALTER TABLE mcp_catalog DROP CONSTRAINT IF EXISTS chk_mcp_catalog_timeout;
ALTER TABLE mcp_catalog ADD CONSTRAINT chk_mcp_catalog_timeout CHECK (timeout_ms BETWEEN 1000 AND 300000);
ALTER TABLE mcp_catalog DROP CONSTRAINT IF EXISTS chk_mcp_catalog_client_secret;
ALTER TABLE mcp_catalog ADD CONSTRAINT chk_mcp_catalog_client_secret
    CHECK (oauth_client_secret_enc IS NULL OR (auth = 'oauth' AND oauth_client_id <> ''));
