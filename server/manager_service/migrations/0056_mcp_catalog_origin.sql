-- 0056: 企业自建 MCP（设计 2026-11-20 §4.4）。幂等：每次部署都会重跑。
-- mcp_catalog 原来只存「从平台目录启用」的条目；企业管理员现在也可以自己登记 MCP。
-- origin 区分两类：platform 复制自 Operator 平台目录（source_revision = 平台修订号）；
-- enterprise 由本企业登记（server_id = 'ent-' || uuid，source_revision 从 1 起每次修改加 1）。
-- (tenant_id, ref) 唯一约束同时覆盖两类：成员本机按 ref 安装，同一企业里 ref 不能重复。

ALTER TABLE mcp_catalog ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'platform';

ALTER TABLE mcp_catalog DROP CONSTRAINT IF EXISTS chk_mcp_catalog_origin;
ALTER TABLE mcp_catalog ADD CONSTRAINT chk_mcp_catalog_origin CHECK (
    (origin = 'platform' AND server_id NOT LIKE 'ent-%')
    OR (origin = 'enterprise' AND server_id LIKE 'ent-%')
);
