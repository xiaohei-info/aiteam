-- 0056: 成员能力授权（设计 2026-11-19 审批策略与能力授权 §3.2 / §3.4）。
-- 记录「成员本机装着哪个企业 MCP」：本机 Agent 安装企业目录 MCP 时上报，卸载时删除；
-- 生命周期跟着安装走，不跟会话走（删对话不影响已装 MCP 刷新登录）。
-- Manager 侧用途只有一个：平台预登记的 MCP OAuth 应用密钥，只下发给装着该 MCP 的成员本机。
-- capability_ref 存平台 server_id（不受本机改名影响）。成员自装能力不上报（只在本机）。
-- 隔离同其它 tenant 表：ENABLE + FORCE RLS。

CREATE TABLE IF NOT EXISTS member_capability_grant (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL,
    member_id            text NOT NULL,
    capability_kind      text NOT NULL,
    capability_ref       text NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_mcg_kind CHECK (capability_kind IN ('mcp')),
    CONSTRAINT uq_mcg_grant UNIQUE (tenant_id, member_id, capability_kind, capability_ref)
);

ALTER TABLE member_capability_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_capability_grant FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON member_capability_grant;
CREATE POLICY tenant_isolation ON member_capability_grant
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON member_capability_grant TO app_rw;
