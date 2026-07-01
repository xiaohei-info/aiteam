-- Conversation 阅读状态（parity Manager 侧 ConversationReadState 单用户一列化）。
-- ALTER TABLE ADD COLUMN 在列已存在时会报错，故用幂等守卫：仅当列不存在时才添加。

ALTER TABLE conversations ADD COLUMN last_read_at TEXT;
ALTER TABLE conversations ADD COLUMN last_read_message_id TEXT;
