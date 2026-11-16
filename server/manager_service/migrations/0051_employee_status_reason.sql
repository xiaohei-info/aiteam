-- R3 发布范围收窄：记录员工被自动停用的原因。
--   catalog_scope_revoked              原为启用，被自动暂停；范围恢复后自动恢复为启用
--   catalog_scope_revoked_keep_paused  原本就不是启用，状态不变；范围恢复后只清空原因
-- 两个取值都会挡住“启用”和“复制”。status_reason 与 status 一起变更，version 由 status 变化触发递增。
ALTER TABLE employee ADD COLUMN IF NOT EXISTS status_reason text;
ALTER TABLE employee DROP CONSTRAINT IF EXISTS chk_employee_status_reason;
ALTER TABLE employee ADD CONSTRAINT chk_employee_status_reason
    CHECK (status_reason IS NULL OR status_reason IN ('catalog_scope_revoked', 'catalog_scope_revoked_keep_paused'));
