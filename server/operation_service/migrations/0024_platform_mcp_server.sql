-- 0024: Operator 平台 MCP 目录（设计 §11.3，2026-11-18）。幂等：每次部署都会重跑。
-- 平台认可的免凭据 streamable-HTTP MCP 端点；企业启用到本企业目录后成员可在对话中自行安装。
-- revision：每次修改加 1，企业端据此判断启用的副本是否落后。

CREATE TABLE IF NOT EXISTS platform_mcp_server (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ref                  text NOT NULL,
    display_name         text NOT NULL,
    summary              text NOT NULL DEFAULT '',
    url                  text NOT NULL,
    tools                jsonb NOT NULL DEFAULT '[]'::jsonb,
    requires_credentials boolean NOT NULL DEFAULT false,
    revision             integer NOT NULL DEFAULT 1,
    status               text NOT NULL DEFAULT 'draft',
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_platform_mcp_server_ref UNIQUE (ref),
    CONSTRAINT chk_platform_mcp_server_status CHECK (status IN ('draft', 'published', 'unpublished')),
    CONSTRAINT chk_platform_mcp_server_url CHECK (url LIKE 'https://%'),
    CONSTRAINT chk_platform_mcp_server_revision CHECK (revision >= 1)
);

CREATE OR REPLACE FUNCTION platform_mcp_server_touch_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_platform_mcp_server_touch ON platform_mcp_server;
CREATE TRIGGER trg_platform_mcp_server_touch BEFORE UPDATE ON platform_mcp_server
FOR EACH ROW EXECUTE FUNCTION platform_mcp_server_touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON platform_mcp_server TO app_rw;
