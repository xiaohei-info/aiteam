-- 会话方案实例绑定（固定编排入口：从 Operator 行业方案"创建群聊"时设置）。
-- solution_instance_id 标记本会话绑定到哪个方案实例；三阶段 prompts + expert_employee_ids 是
-- 方案级快照，group.py 在 orchestrated 模式下直接读取三阶段 prompts 作为固定编排规则，
-- roster 过滤按 solution_expert_employee_ids。
-- solution_instance_id 空 = 未绑定（自由创建群聊），prompts 空串 = 回退运行时默认。

ALTER TABLE conversations ADD COLUMN solution_instance_id TEXT;
ALTER TABLE conversations ADD COLUMN solution_planner_prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN solution_subtask_prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN solution_aggregate_prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN solution_expert_employee_ids TEXT NOT NULL DEFAULT '[]';
