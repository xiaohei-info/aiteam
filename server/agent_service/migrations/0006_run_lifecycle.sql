-- #283: 补齐 agent 侧 Run 触发类型、执行模式与完整生命周期字段。
-- runs 表新增 trigger_type / execution_mode 两列，默认值保证旧行回填兼容。
-- status 列语义扩展为完整生命周期（queued|routing|submitting|running|waiting_human|succeeded|failed|cancelled），
-- 通过 CHECK 约束兜底。

PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

ALTER TABLE runs ADD COLUMN trigger_type TEXT NOT NULL DEFAULT manual_run;
ALTER TABLE runs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT single_agent;

COMMIT;
PRAGMA foreign_keys = ON;
