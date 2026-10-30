-- 段落结果评估小时汇总（议题 1 / 议题 7：员工与人才市场解决率）。
-- 幂等：可重复执行（IF NOT EXISTS / DO 块）。
--
-- 设计口径：
--   - 来源：Agent 经 F13 /api/manager/usage/upload 的 segment_outcomes[] 上报，每行是
--     「成员 + 员工 + 段落结束所在 UTC 小时」内的已评估/已解决段数（绝对值，不是增量）。
--     成员在 7 天内修改或撤销评估时 Agent 重发同一 summary_id，本表覆盖为最新值。
--   - 只存计数：不含会话文本、评估备注或原因标签；不进入 usage_rollup 账本与 Operator delivery。
--   - 本表由 Manager 单写；tenant_id 唯一来源是 TenantContext（D22），RLS 同 0001/0007。

CREATE TABLE IF NOT EXISTS segment_outcome_rollup (
    tenant_id           uuid NOT NULL,
    summary_id          text NOT NULL,
    member_id           uuid NOT NULL,
    employee_id         uuid NOT NULL,
    window_start        timestamptz NOT NULL,
    window_end          timestamptz NOT NULL,
    evaluated_count     integer NOT NULL DEFAULT 0,
    resolved_count      integer NOT NULL DEFAULT 0,
    received_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_segment_outcome_rollup PRIMARY KEY (tenant_id, summary_id),
    CONSTRAINT ck_segment_outcome_counts CHECK (
        evaluated_count >= 0 AND resolved_count >= 0 AND resolved_count <= evaluated_count
    ),
    CONSTRAINT ck_segment_outcome_window CHECK (window_end > window_start)
);

CREATE INDEX IF NOT EXISTS idx_segment_outcome_rollup_employee
    ON segment_outcome_rollup (tenant_id, employee_id, window_start);
CREATE INDEX IF NOT EXISTS idx_segment_outcome_rollup_member
    ON segment_outcome_rollup (tenant_id, member_id, window_start);

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['segment_outcome_rollup']
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
