-- 0013: 招募订单 RecruitmentOrder（AITEAM-243 / GitHub #287）。
-- 幂等：可重复执行（IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DO 块）。
--
-- 设计口径：追踪 Manager 端每个招募动作（recruit_expert / apply_solution 内各专家的展开）
-- 的异步执行链路：pending → provisioning → succeeded / failed / cancelled。
-- 每个 order 对应一个 created_employee_id（单专家粒度）。幂等键 (tenant_id, idempotency_key)
-- 防重发；失败后可从 order 读取 error_code / error_message 复盘与重试。
--
-- tenant_id 唯一来源是 TenantContext（D22），业务 SQL 不接受手写 tenant 过滤。
-- RLS ENABLE + FORCE（与 solution_instance / recruit_event 同口径，04 §6.1.1）。

CREATE TABLE IF NOT EXISTS recruitment_order (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    idempotency_key     text NOT NULL,
    action              text NOT NULL DEFAULT 'recruit_expert',
    template_id         text,
    solution_id         text,
    requested_by        uuid,
    created_employee_id uuid,
    status              text NOT NULL DEFAULT 'pending',
    error_code          text,
    error_message       text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_recruitment_order_idempotent UNIQUE (tenant_id, idempotency_key),
    CONSTRAINT chk_recruitment_order_status
        CHECK (status IN ('pending', 'provisioning', 'succeeded', 'failed', 'cancelled')),
    CONSTRAINT chk_recruitment_order_action
        CHECK (action IN ('recruit_expert', 'apply_solution'))
);

-- updated_at 自动刷新（供增量/监控比对）。
CREATE OR REPLACE FUNCTION recruitment_order_touch_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recruitment_order_touch ON recruitment_order;
CREATE TRIGGER trg_recruitment_order_touch
BEFORE UPDATE ON recruitment_order
FOR EACH ROW
EXECUTE FUNCTION recruitment_order_touch_updated_at();

-- RLS：ENABLE + FORCE + 策略 + app_rw 授权（同 0001/0006 口径）。
-- ENABLE/FORCE ROW LEVEL SECURITY 本身幂等（重复执行无害），无需守卫；
-- 原 pg_tables.forcerowsecurity 守卫引用了不存在的列（pg_tables 无此列），全新库会报错。
DO $$
BEGIN
    EXECUTE 'ALTER TABLE recruitment_order ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE recruitment_order FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON recruitment_order';
    EXECUTE format(
        'CREATE POLICY tenant_isolation ON recruitment_order '
        'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)'
    );
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON recruitment_order TO app_rw';
END
$$;
