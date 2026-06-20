-- 企业级 usage/audit rollup + 软配额治理（M8，04 §6.5/§6.5.1，D13/D24）。
-- 幂等：可重复执行（IF NOT EXISTS / DO 块）。
--
-- 设计口径（04 §6.5/§6.5.1，D13/D24）：
--   - 治理闭环靠**脱敏聚合摘要**逐级上报（Agent → Manager → Operator）；会话内容/执行明细/
--     逐 token 明文**绝不上传**，本端只接脱敏摘要（D13 本地优先/隐私）。
--   - 配额默认**软配额 + 事后治理**：不每 run 强领 quota lease（否则 Manager 离线会阻断本地执行，
--     破坏 D14）。本端在收到 usage summary 后执行告警/限流**建议**等软动作，不强制阻断。
--   - 仅做**本企业**（租户内）汇总，不做跨企业汇总（跨企业归 O3 运营端 cross_enterprise_usage_rollup）。
--
-- 隔离硬约束（04 §6.1.1，D22）：
--   - tenant_id 唯一来源是 TenantContext；业务 SQL 不接受调用方手写 tenant 过滤。
--   - 三表均租户作用域：ENABLE + FORCE ROW LEVEL SECURITY + SET LOCAL app.tenant_id 策略。

-- ---- 1. usage_rollup：计量聚合摘要（按 summary_id 幂等去重）----
-- 来源：Agent 经 F13 UsageSummaryUpload 上报的脱敏 UsageSummary。
-- 字段对齐 shared.contracts.summary.UsageSummary：金额 Decimal(存 numeric)，token int。
-- 红线：本表**不含**任何会话文本/prompt/token 明文/run 内容，只存聚合计量。
CREATE TABLE IF NOT EXISTS usage_rollup (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    summary_id      text NOT NULL,
    employee_id     uuid,
    window_start    timestamptz NOT NULL,
    window_end      timestamptz NOT NULL,
    run_count       integer NOT NULL DEFAULT 0,
    token_total     bigint  NOT NULL DEFAULT 0,
    cost_total      numeric(18,6) NOT NULL DEFAULT 0,
    error_count     integer NOT NULL DEFAULT 0,
    duration_seconds_total integer NOT NULL DEFAULT 0,
    received_at     timestamptz NOT NULL DEFAULT now(),
    -- 幂等：同 tenant 同 summary_id 只落一条（F13 按 summary_id 去重，04 §6.5）。
    CONSTRAINT uq_usage_rollup_summary UNIQUE (tenant_id, summary_id)
);

-- ---- 2. audit_summary_event：关键审计事件摘要（按 summary_id 幂等）----
-- 来源：Agent 经 F13 上报的脱敏 AuditSummaryEvent（招募装载/登录/授权变更/越权尝试）。
-- 红线：本表**不含**会话内容；只存事件级元数据（actor/action/resource/occurred_at）。
CREATE TABLE IF NOT EXISTS audit_summary_event (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    summary_id      text NOT NULL,
    actor           text NOT NULL,
    action          text NOT NULL,
    resource_type   text,
    resource_id     text,
    occurred_at     timestamptz NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT now(),
    -- 幂等：同 tenant 同 summary_id 只落一条（04 §6.5）。
    CONSTRAINT uq_audit_summary_event UNIQUE (tenant_id, summary_id)
);

-- ---- 3. quota_policy：软配额策略（租户作用域，D24）----
-- v1 默认软配额：enforcement=soft（告警/建议，不阻断 run）。
-- 可选硬配额模式（hard）必须在产品上显式标记"牺牲离线可用性换成本控制"（04 §6.5.1）。
-- window/dimensions 为中立策略 JSON（cost_cap_usd / token_cap / run_cap 等），不含会话内容。
CREATE TABLE IF NOT EXISTS quota_policy (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    policy_slug     text NOT NULL,
    display_name    text NOT NULL DEFAULT '',
    scope           text NOT NULL DEFAULT 'tenant',  -- tenant | employee | member
    target_ref      text,  -- scope=employee/member 时的目标 id；scope=tenant 时 NULL
    window_start    timestamptz NOT NULL DEFAULT now(),
    window_end      timestamptz NOT NULL DEFAULT now() + interval '30 days',
    dimensions      jsonb   NOT NULL DEFAULT '{}'::jsonb,  -- 中立策略维度（cap/threshold）
    enforcement     text    NOT NULL DEFAULT 'soft',  -- soft | hard（D24：默认 soft）
    status          text    NOT NULL DEFAULT 'active',  -- active | paused
    version         integer NOT NULL DEFAULT 1,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- 租户内 slug 唯一（unique 带 tenant_id，04 §6.1.1 第 2 条）。
    CONSTRAINT uq_quota_policy_slug UNIQUE (tenant_id, policy_slug)
);

-- quota_policy 配置变更时推进 version + updated_at。
CREATE OR REPLACE FUNCTION quota_policy_touch_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.version := COALESCE(OLD.version, 0) + 1;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quota_policy_touch ON quota_policy;
CREATE TRIGGER trg_quota_policy_touch
BEFORE UPDATE OF display_name, scope, target_ref, window_start, window_end,
                 dimensions, enforcement, status
ON quota_policy
FOR EACH ROW
EXECUTE FUNCTION quota_policy_touch_updated_at();

-- ---- RLS：三表 ENABLE + FORCE + 策略（照 0001 范式，04 §6.1.1）----
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['usage_rollup', 'audit_summary_event', 'quota_policy']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
            'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
            t
        );
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_rw', t);
    END LOOP;
END
$$;
