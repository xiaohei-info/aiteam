-- 0025: 平台 MCP 条目鉴权字段（设计 2026-11-18 MCP鉴权与配置导入 §3.8 / §3.10）。幂等：每次部署都会重跑。
-- requires_credentials(bool) → auth(none|oauth|bearer)：旧 true 视为 bearer（成员自填令牌）。
-- 平台永不保存成员令牌；唯一可保存的机密是服务方发的 OAuth 应用密钥，Fernet 加密入库（只写不读）。

ALTER TABLE platform_mcp_server ADD COLUMN IF NOT EXISTS auth text NOT NULL DEFAULT 'none';
ALTER TABLE platform_mcp_server ADD COLUMN IF NOT EXISTS auth_header text NOT NULL DEFAULT '';
ALTER TABLE platform_mcp_server ADD COLUMN IF NOT EXISTS oauth_scopes text NOT NULL DEFAULT '';
ALTER TABLE platform_mcp_server ADD COLUMN IF NOT EXISTS timeout_ms integer NOT NULL DEFAULT 30000;
ALTER TABLE platform_mcp_server ADD COLUMN IF NOT EXISTS oauth_client_id text NOT NULL DEFAULT '';
ALTER TABLE platform_mcp_server ADD COLUMN IF NOT EXISTS oauth_client_secret_enc bytea;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'platform_mcp_server' AND column_name = 'requires_credentials'
    ) THEN
        UPDATE platform_mcp_server SET auth = 'bearer' WHERE requires_credentials AND auth = 'none';
        ALTER TABLE platform_mcp_server DROP COLUMN requires_credentials;
    END IF;
END $$;

ALTER TABLE platform_mcp_server DROP CONSTRAINT IF EXISTS chk_platform_mcp_server_auth;
ALTER TABLE platform_mcp_server ADD CONSTRAINT chk_platform_mcp_server_auth CHECK (auth IN ('none', 'oauth', 'bearer'));
ALTER TABLE platform_mcp_server DROP CONSTRAINT IF EXISTS chk_platform_mcp_server_timeout;
ALTER TABLE platform_mcp_server ADD CONSTRAINT chk_platform_mcp_server_timeout CHECK (timeout_ms BETWEEN 1000 AND 300000);
-- 应用密钥只对 oauth 条目且有应用编号时有意义。
ALTER TABLE platform_mcp_server DROP CONSTRAINT IF EXISTS chk_platform_mcp_server_client_secret;
ALTER TABLE platform_mcp_server ADD CONSTRAINT chk_platform_mcp_server_client_secret
    CHECK (oauth_client_secret_enc IS NULL OR (auth = 'oauth' AND oauth_client_id <> ''));
