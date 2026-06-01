-- 002: conversation_message table + latest_message_id column
-- Minimal addition for group-message business-truth persistence per L2-REWORK-F01b

CREATE TABLE IF NOT EXISTS conversation_message (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation(id),
    run_id TEXT,
    sender_id TEXT NOT NULL,
    sender_type TEXT NOT NULL CHECK(sender_type IN ('employee','user')),
    message_text TEXT NOT NULL DEFAULT '',
    message_json JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conv_message_conversation ON conversation_message(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conv_message_run ON conversation_message(run_id);

-- Add latest_message_id to conversation for summary writeback (§5.4 design)
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS latest_message_id TEXT;
