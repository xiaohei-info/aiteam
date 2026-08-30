-- 0033: 部门归属属于 employee 配置投影，变更时递增 version。
-- department_ids 已由 0012 创建；这里只扩展现有配置触发器的列清单。

DROP TRIGGER IF EXISTS trg_employee_config_touch ON employee;
CREATE TRIGGER trg_employee_config_touch
BEFORE UPDATE OF persona, model, provider_ref, thinking_level,
                 timeout_seconds, tools, skills,
                 knowledge_refs, connector_refs, memory_policy,
                 display_name, department_ids
ON employee
FOR EACH ROW
EXECUTE FUNCTION employee_touch_updated_at();
