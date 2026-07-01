-- SolutionApplyRecord — 企业端方案应用记录（AITEAM-242，issue #286 gap）。
-- 记录谁在何时将哪一版本方案应用到本 tenant，状态与应用结果，可供审计追溯方案应用历史。
--
-- 对照旧 app/team_panel/domain/entities.py:SolutionApplyRecord
--  字段口径：applied_by, applied_at, solution_version, status, expert_instances_created
-- 本表落点（04 §6.1 企业端 Manager tenant data space）+ RLS（04 §6.1.1，D22）。
--
-- status 取值：applied | revoked（暂不引入 pending/cancelled：apply 同步落实例即完成，
-- 失败走异常回滚，不写半条记录；revoked 由运营端/管理操作触发）。
-- tenant_id 唯一来源 TenantContext（D22），业务 SQL 不接受手写 tenant 过滤。

CREATE TABLE IF NOT EXISTS solution_apply_record (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL,
    solution_id          text NOT NULL,
    solution_version     text NOT NULL DEFAULT '',
    applied_by           uuid,
    status               text NOT NULL DEFAULT 'applied',
    expert_instance_ids  uuid[] NOT NULL DEFAULT '{}',
    detail               jsonb,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_solution_apply_record UNIQUE (tenant_id, solution_id, solution_version),
    CONSTRAINT chk_solution_apply_record_status CHECK (status IN ('applied', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_solution_apply_record_tenant_solution
    ON solution_apply_record (tenant_id, solution_id, created_at DESC);

-- ---- RLS：ENABLE + FORCE + 策略 + app_rw 授权（同 0006/0011 口径）----
DO $$
BEGIN
    EXECUTE 'ALTER TABLE solution_apply_record ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE solution_apply_record FORCE ROW LEVEL SECURITY';
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', 'solution_apply_record');
    EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I '
        'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
        'solution_apply_record'
    );
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON solution_apply_record TO app_rw';
END
$$;
