-- employee_prompt 版本管理 + 历史追踪（issue #303 gap）。
-- 幂等：可重复执行（IF NOT EXISTS / DO 块）。
--
-- 本迁移补齐旧版 app/team_panel employee_prompt 表在 v1 manager_service 中缺失的问题：
--   1. employee_prompt        — 1:1 的 employee prompt 当前版本（head），tenant_id + RLS 隔离。
--   2. employee_prompt_history — append-only 版本历史，供版本追踪与回滚溯源。
--
-- 隔离硬约束同 0001：ENABLE + FORCE RLS、tenant_id 唯一来源 TenantContext（D22）、
-- app_rw 受约束角色。
--
-- 版本号语义：
--   employee_prompt.version_no 为当前活跃版本号，每次 update/rollback 单调 +1；
--   employee_prompt_history.version_no 记录该行落库时对应的 NO，与 employee_id 组成 UNIQUE 约束。
--
-- source_template_version 追溯 prompt 来源（从哪个 template version 继承），
-- 起源模板本身可能跨版本存在，故独立于 version_no（内版自增）之外。

CREATE TABLE IF NOT EXISTS employee_prompt (
    id              uuid PRIMARY KEY,                       -- = employee.id
    tenant_id       uuid NOT NULL,
    system_prompt   text NOT NULL DEFAULT '',
    behavior_rules_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    opening_message text,
    version_no      integer NOT NULL DEFAULT 1,
    source_template_version text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_employee_prompt_employee FOREIGN KEY (id) REFERENCES employee(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_employee_prompt_tenant ON employee_prompt(tenant_id);
CREATE INDEX IF NOT EXISTS idx_employee_prompt_source_template ON employee_prompt(source_template_version);

CREATE TABLE IF NOT EXISTS employee_prompt_history (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    employee_id     uuid NOT NULL,
    system_prompt   text NOT NULL DEFAULT '',
    behavior_rules_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    opening_message text,
    version_no      integer NOT NULL,
    source_template_version text,
    change_reason   text,
    changed_by      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_employee_prompt_history_version UNIQUE (employee_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_employee_prompt_history_tenant ON employee_prompt_history(tenant_id);
CREATE INDEX IF NOT EXISTS idx_employee_prompt_history_employee ON employee_prompt_history(tenant_id, employee_id, version_no DESC);

-- 配置变更时刷新 updated_at（供增量 sync 比对）。
CREATE OR REPLACE FUNCTION employee_prompt_touch_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_employee_prompt_touch ON employee_prompt;
CREATE TRIGGER trg_employee_prompt_touch
BEFORE UPDATE ON employee_prompt
FOR EACH ROW
EXECUTE FUNCTION employee_prompt_touch_updated_at();

-- RLS + 权限
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['employee_prompt', 'employee_prompt_history']
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
