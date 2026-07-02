-- 修正 0014 引入的回归：employee 版本触发器的"配置变更列清单"漏了 display_name。
--
-- 0002 原语义：repo.update 的 SET 列表含全部配置列 → 任何 update 都推进 version；
-- 0014 改为"列值真正变化（IS DISTINCT FROM）才推进"（语义更优，no-op 不推进），
-- 但清单漏了 display_name → 仅改名不推进 version，增量 sync（F10 known_versions）
-- 与快照冻结（04 §6.3）感知不到该配置变更。display_name 属配置面（EmployeeConfigOut），
-- 必须纳入。status/archive_* 仍归生命周期，不推进 version（0014 口径不变）。
CREATE OR REPLACE FUNCTION employee_touch_updated_at()
RETURNS trigger AS $$
BEGIN
    -- 配置相关列改写 → version 单调递增（供增量 sync / 快照冻结）。
    IF (TG_OP = 'UPDATE' AND (
        NEW.display_name IS DISTINCT FROM OLD.display_name OR
        NEW.persona IS DISTINCT FROM OLD.persona OR
        NEW.model IS DISTINCT FROM OLD.model OR
        NEW.provider_ref IS DISTINCT FROM OLD.provider_ref OR
        NEW.thinking_level IS DISTINCT FROM OLD.thinking_level OR
        NEW.runtime_binding IS DISTINCT FROM OLD.runtime_binding OR
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
