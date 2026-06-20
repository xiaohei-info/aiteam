-- 企业级本地审计日志 enterprise_audit（M7-followup #87，04 §6 行30/§6 审计日志口径，05 F16）。
-- 幂等：可重复执行（IF NOT EXISTS / DO 块）。
--
-- 设计口径（04「审计日志」：enterprise_audit 必须带 tenant_id、actor、resource_type、resource_id，
-- 不记录会话内容；05 F16：Agent 越权拉专家/知识，Manager 返回 403 并记 enterprise_audit）：
--   - 本表记录 **Manager 自身在执行 enforcement 时本地产生**的审计事件（如快照拉取越权拦截），
--     与 audit_summary_event（消费 Agent 经 F13 上报的脱敏 rollup 摘要）语义不同：
--     enterprise_audit = 本端产生；audit_summary_event = 上报消费。两者不可混用。
--   - 红线（D13）：只存事件级元数据（actor/action/resource/拒因摘要），**绝不**含会话文本/
--     prompt/token 明文/执行配置内容；越权拦截发生在读取专家配置之前，结构上无配置内容可泄。
--   - 不设 summary_id 唯一约束：每次越权尝试都是一条独立审计记录（审计保真，不去重覆盖）。
--
-- 隔离硬约束（04 §6.1.1，D22）：tenant_id 唯一来源是 TenantContext；业务 SQL 不接受调用方手写
-- tenant 过滤；ENABLE + FORCE ROW LEVEL SECURITY + SET LOCAL app.tenant_id 策略。

CREATE TABLE IF NOT EXISTS enterprise_audit (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    actor           text NOT NULL,           -- 触发审计的主体（如发起越权拉取的 member_id）
    action          text NOT NULL,           -- 审计动作（如 snapshot_pull_denied）
    resource_type   text,                    -- 资源类型（如 expert）
    resource_id     text,                    -- 资源 id（如 employee_id）
    detail          text,                    -- 脱敏拒因摘要（不含会话/配置内容），可空
    occurred_at     timestamptz NOT NULL DEFAULT now()
);

-- 按 tenant + 时间倒序检索（审计回溯常见访问模式）。
CREATE INDEX IF NOT EXISTS ix_enterprise_audit_tenant_time
    ON enterprise_audit (tenant_id, occurred_at DESC);

-- ---- RLS：ENABLE + FORCE + 策略（照 0007 范式，04 §6.1.1）----
DO $$
BEGIN
    EXECUTE 'ALTER TABLE enterprise_audit ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE enterprise_audit FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON enterprise_audit';
    EXECUTE
        'CREATE POLICY tenant_isolation ON enterprise_audit '
        'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)';
    EXECUTE 'GRANT SELECT, INSERT ON enterprise_audit TO app_rw';
END
$$;
