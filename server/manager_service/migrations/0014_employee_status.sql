-- employee 生命周期状态机（issue #281）：补齐 status 主状态 + 归档元数据。
-- 状态口径：draft → provisioning → active ↔ paused → archived
--                          ↓
--                  provisioning_failed（可重试）
--
-- 隔离硬约束（04 §6.1.1）：employee 表已有 RLS（0001 建立）；本迁移仅扩列+状态约束，不动隔离策略。
-- tenant_id 唯一来源是 TenantContext（D22）；状态取值对齐 EmployeeStatus 枚举（CHECK 兜底）。
-- 状态流转的业务校验 + 落库在 service 层（employee_lifecycle.py），不在 DB 函数内。

-- ---- 1) 状态主字段（默认 draft：新 employee 创建即未就绪）----
ALTER TABLE employee ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft';

-- ---- 2) 状态合法性兜底（对齐 EmployeeStatus 枚举，禁取枚举外值）----
ALTER TABLE employee DROP CONSTRAINT IF EXISTS chk_employee_status;
ALTER TABLE employee ADD CONSTRAINT chk_employee_status
    CHECK (status IN ('draft', 'provisioning', 'active', 'paused', 'provisioning_failed', 'archived'));

-- ---- 3) 归档元数据：archive 动作写入原因/时间（供审计/历史追溯）----
ALTER TABLE employee ADD COLUMN IF NOT EXISTS archive_reason text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- ---- 4) 仅状态列被改写时也刷新 updated_at（不推进 version；version 归配置变更）----
CREATE OR REPLACE FUNCTION employee_touch_updated_at()
RETURNS trigger AS $$
BEGIN
    -- 配置相关列改写 → version 单调递增（供增量 sync / 快照冻结）。
    IF (TG_OP = 'UPDATE' AND (
        NEW.persona IS DISTINCT FROM OLD.persona OR
        NEW.model IS DISTINCT FROM OLD.model OR
        NEW.provider_ref IS DISTINCT FROM OLD.provider_ref OR
        NEW.thinking_level IS DISTINCT FROM OLD.thinking_level OR
        NEW.timeout_seconds IS DISTINCT FROM OLD.timeout_seconds OR
        NEW.tools IS DISTINCT FROM OLD.tools OR
        NEW.skills IS DISTINCT FROM OLD.skills OR
        NEW.knowledge_refs IS DISTINCT FROM OLD.knowledge_refs OR
        NEW.connector_refs IS DISTINCT FROM OLD.connector_refs OR
        NEW.memory_policy IS DISTINCT FROM OLD.memory_policy
    )) THEN
        NEW.version := COALESCE(OLD.version, 0) + 1;
    END IF;
    -- 任何改写（含 status）都刷新 updated_at。
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_employee_config_touch ON employee;
CREATE TRIGGER trg_employee_config_touch
BEFORE UPDATE ON employee
FOR EACH ROW
EXECUTE FUNCTION employee_touch_updated_at();
