-- AITEAM-288（GH#403）：方案实例编辑配置。
--
-- 为 solution_instance 增加协作编排 prompts 列，使已应用方案实例可在本 tenant 内独立编辑
-- planner/subtask/aggregate 提示词（方案级覆盖，空值 = 回退运行时默认）。
--
-- 红线：不改 RLS 策略；列新增幂等（IF NOT EXISTS）。
-- 隔离硬约束不变（0006 ENABLE + FORCE RLS，app_rw 已授权）。

ALTER TABLE solution_instance
    ADD COLUMN IF NOT EXISTS planner_prompt text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS subtask_prompt text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS aggregate_prompt text NOT NULL DEFAULT '';
