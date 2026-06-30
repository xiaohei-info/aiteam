-- run_event（运行事件明细）+ usage_ledger（逐 token 计费明细）
-- 补齐 Manager usage/audit 模块缺失的事件追踪能力（issue #292 / GitHub #292，
-- 对照旧 app/team_panel/domain/entities.py:RunEvent + repositories/usage_ledger_repo.py）。
--
-- 设计口径：
--   - run_event = run 粒度的 runtime 归一事件**脱敏归档**。按 (tenant_id, run_id, cursor_no)
--     唯一，ON CONFLICT DO NOTHING（重复归档静默去重）。仅做事件元数据镜像，不存会话内容（D13）。
--     cursor_no 单调递增，供北向 cursor 分页 + max-cursor 水位跟踪。
--   - usage_ledger = 逐 run token 计费明细行。按 (tenant_id, run_id, source_type) 幂等回写
--     （F13 重复上报以最新值覆盖）。仅计量数字（tokens/cost_cents/occurred_at），不存会话内容（D13）。
--
-- 红线（D13）：两表**不含**任何会话文本/prompt/session 内容/工具输入输出字段。
-- 隔离硬约束（04 §6.1.1，D22）：tenant_id 只从 TenantContext 读；ENABLE + FORCE RLS + app_rw。

CREATE TABLE IF NOT EXISTS run_event (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    run_id          uuid NOT NULL,
    cursor_no       integer NOT NULL,
    event_type      text NOT NULL,
    source_type     text NOT NULL DEFAULT 'session',  -- session | kanban_task | cron_job | gateway | system
    source_id       uuid,
    team_task_id    uuid,
    employee_id     uuid,
    event_ts        timestamptz NOT NULL DEFAULT now(),
    preview_text    text NOT NULL DEFAULT '',
    payload_json    jsonb   NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_run_event_cursor UNIQUE (tenant_id, run_id, cursor_no)
);

CREATE INDEX IF NOT EXISTS ix_run_event_run_cursor
    ON run_event (tenant_id, run_id, cursor_no);

CREATE TABLE IF NOT EXISTS usage_ledger (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    employee_id     uuid NOT NULL,
    run_id          uuid NOT NULL,
    conversation_id uuid,
    input_tokens    integer NOT NULL DEFAULT 0,
    output_tokens   integer NOT NULL DEFAULT 0,
    total_tokens    integer NOT NULL DEFAULT 0,
    cost_cents      integer NOT NULL DEFAULT 0,
    source_type     text NOT NULL DEFAULT 'run_summary',  -- run_summary | usage_event | backfill
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      text,
    CONSTRAINT uq_ledger_run_source UNIQUE (tenant_id, run_id, source_type)
);

CREATE INDEX IF NOT EXISTS ix_usage_ledger_tenant_run
    ON usage_ledger (tenant_id, run_id);
CREATE INDEX IF NOT EXISTS ix_usage_ledger_tenant_employee
    ON usage_ledger (tenant_id, employee_id);

-- ---- RLS：两表 ENABLE + FORCE + 策略（照 0007 范式，04 §6.1.1）----
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['run_event', 'usage_ledger']
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
