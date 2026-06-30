-- 会话协作编排字段（parity Manager侧 Conversation.collaboration_mode / orchestration_brief）。
-- ALTER TABLE ADD COLUMN 在列已存在时会报错，故用幂等守卫：仅当列不存在时才添加。

ALTER TABLE conversations ADD COLUMN collaboration_mode TEXT NOT NULL DEFAULT 'free';
ALTER TABLE conversations ADD COLUMN orchestration_brief TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN planner_employee_id TEXT;
