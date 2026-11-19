-- 0055: 企业 MCP 目录（设计 §11.3，2026-11-18）。幂等：每次部署都会重跑。
-- 企业管理员把 Operator 平台 MCP 目录里已发布的条目「启用」到本企业：复制一份平台条目，
-- 记 source_revision 以判断是否落后于平台。成员只能自行安装本表中、且不需要凭据的 MCP。
-- 隔离同其它 tenant 表：ENABLE + FORCE RLS，业务唯一性带 tenant_id。
-- 需鉴权的条目也进入成员可装列表，凭据由成员本机自行登录 / 填写，企业端永不保存成员令牌。
-- 平台预登记的 OAuth 应用密钥由 Operator 服务间下发，企业端用自己的密钥（MANAGER_CREDENTIAL_KEY）重新加密保存。

CREATE TABLE IF NOT EXISTS mcp_catalog (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL,
    server_id            text NOT NULL,
    ref                  text NOT NULL,
    display_name         text NOT NULL,
    summary              text NOT NULL DEFAULT '',
    url                  text NOT NULL,
    tools                jsonb NOT NULL DEFAULT '[]'::jsonb,
    auth                 text NOT NULL DEFAULT 'none',
    auth_header          text NOT NULL DEFAULT '',
    oauth_scopes         text NOT NULL DEFAULT '',
    timeout_ms           integer NOT NULL DEFAULT 30000,
    oauth_client_id      text NOT NULL DEFAULT '',
    oauth_client_secret_enc bytea,
    source_revision      integer NOT NULL,
    enabled_by           text NOT NULL DEFAULT '',
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_mcp_catalog_server UNIQUE (tenant_id, server_id),
    CONSTRAINT uq_mcp_catalog_ref UNIQUE (tenant_id, ref),
    CONSTRAINT chk_mcp_catalog_url CHECK (url LIKE 'https://%'),
    CONSTRAINT chk_mcp_catalog_auth CHECK (auth IN ('none', 'oauth', 'bearer')),
    CONSTRAINT chk_mcp_catalog_timeout CHECK (timeout_ms BETWEEN 1000 AND 300000),
    CONSTRAINT chk_mcp_catalog_client_secret
        CHECK (oauth_client_secret_enc IS NULL OR (auth = 'oauth' AND oauth_client_id <> ''))
);

ALTER TABLE mcp_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_catalog FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp_catalog;
CREATE POLICY tenant_isolation ON mcp_catalog
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_catalog TO app_rw;
