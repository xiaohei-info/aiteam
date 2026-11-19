-- 0056: 成员能力授权（设计 2026-11-19 审批策略与能力授权 §3.2 / §3.4）。
-- 成员批准安装某个能力（MCP / 技能）后，本机 Agent 上报一条授权，仅本会话有效。
-- Manager 侧用途只有一个：平台预登记的 MCP OAuth 应用密钥，只在成员已授权时才下发给他的本机 Agent。
-- 隔离同其它 tenant 表：ENABLE + FORCE RLS。会话结束 / 成员撤销时删除。

CREATE TABLE IF NOT EXISTS member_capability_grant (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL,
    member_id            text NOT NULL,
    conversation_id      text NOT NULL,
    capability_kind      text NOT NULL,
    capability_ref       text NOT NULL,
    source               text NOT NULL DEFAULT '',
    scope                text NOT NULL DEFAULT 'session',
    created_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_mcg_kind CHECK (capability_kind IN ('mcp', 'skill')),
    CONSTRAINT chk_mcg_scope CHECK (scope IN ('session')),
    CONSTRAINT uq_mcg_grant UNIQUE (tenant_id, member_id, conversation_id, capability_kind, capability_ref)
);

ALTER TABLE member_capability_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_capability_grant FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON member_capability_grant;
CREATE POLICY tenant_isolation ON member_capability_grant
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON member_capability_grant TO app_rw;
