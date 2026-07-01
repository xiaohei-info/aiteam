-- Conversation 员工归属列（parity 企业侧 Conversation.entry_employee_id）。
-- 工作台 get_workbench 按员工索引私聊会话、推导未读。
-- ADD COLUMN 已存在时报错，沿用 0006_read_status 模式（首次迁移加列，后续跳过）。
ALTER TABLE conversations ADD COLUMN entry_employee_id TEXT;
