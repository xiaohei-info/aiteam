-- Loop 实体补齐 ScheduledJob 口径，增强定时/重试/模板能力（AITEAM-244 / GitHub #289）。
-- 仅可重入的小步迁移；新增列带防御式 DEFAULT 使 ADD COLUMN 对存量行安全。
-- SQLite ADD COLUMN 不可加 IF NOT EXISTS，迁移脚本由 schema_migrations 记录防重复应用；
-- status 取值从旧口径 (enabled/disabled) 迁移到新口径 (active/paused)，可重入。

ALTER TABLE loops ADD COLUMN recurrence_type     TEXT    NOT NULL DEFAULT 'cron';
ALTER TABLE loops ADD COLUMN recurrence_config   TEXT;
ALTER TABLE loops ADD COLUMN input_template      TEXT;
ALTER TABLE loops ADD COLUMN max_retries         INTEGER NOT NULL DEFAULT 3;
ALTER TABLE loops ADD COLUMN retry_count         INTEGER NOT NULL DEFAULT 0;

UPDATE loops SET status='active'  WHERE status='enabled';
UPDATE loops SET status='paused'  WHERE status='disabled';
