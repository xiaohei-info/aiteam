-- 012: 方案应用后自动建群 — apply_record 记录对应的 conversation_id，
-- 支撑「复用+刷新」与幂等返回。DB 列默认空，存量记录行为不变。

ALTER TABLE solution_apply_record
    ADD COLUMN IF NOT EXISTS conversation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_solution_apply_record_conversation
    ON solution_apply_record(enterprise_id, solution_id, conversation_id)
    WHERE deleted_at IS NULL AND conversation_id IS NOT NULL;
