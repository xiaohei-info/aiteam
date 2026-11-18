-- 0055: 企业 MCP 目录（设计 §11.3，2026-11-18）。幂等：每次部署都会重跑。
-- 企业管理员把 Operator 平台 MCP 目录里已发布的条目「启用」到本企业：复制一份平台条目，
-- 记 source_revision 以判断是否落后于平台。成员只能自行安装本表中、且不需要凭据的 MCP。
-- 隔离同其它 tenant 表：ENABLE + FORCE RLS，业务唯一性带 tenant_id。

CREATE TABLE IF NOT EXISTS mcp_catalog (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL,
    server_id            text NOT NULL,
    ref                  text NOT NULL,
    display_name         text NOT NULL,
    summary              text NOT NULL DEFAULT '',
    url                  text NOT NULL,
    tools                jsonb NOT NULL DEFAULT '[]'::jsonb,
    requires_credentials boolean NOT NULL DEFAULT false,
    source_revision      integer NOT NULL,
    enabled_by           text NOT NULL DEFAULT '',
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_mcp_catalog_server UNIQUE (tenant_id, server_id),
    CONSTRAINT uq_mcp_catalog_ref UNIQUE (tenant_id, ref),
    CONSTRAINT chk_mcp_catalog_url CHECK (url LIKE 'https://%')
);

ALTER TABLE mcp_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_catalog FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp_catalog;
CREATE POLICY tenant_isolation ON mcp_catalog
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_catalog TO app_rw;
