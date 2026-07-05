-- AITEAM-374（PR #12 CI fix）：solution_instance 补 config_version 列。
--
-- recruit_repository.py SolutionInstanceRow + _SOLUTION_COLUMNS 已引用 config_version，
-- authorized_config_service 用 solution_version:config_version 做 Agent 增量 sync etag，
-- 但 0008/0009 迁移漏了这列，致 list/update solution_instance 全部报
--   column "config_version" does not exist（CI 集成测试 + 棘轮 7 fail）。
-- 仅加列，不改 RLS 策略；IF NOT EXISTS 幂等。

ALTER TABLE solution_instance
    ADD COLUMN IF NOT EXISTS config_version integer NOT NULL DEFAULT 1;
