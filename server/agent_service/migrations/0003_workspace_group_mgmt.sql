-- Agent 本地 workspace/group_mgmt 持久化（#267）。
-- datetime 存 ISO 字符串，mentions 等数组存 JSON 文本。

-- P02 工作台偏好
CREATE TABLE IF NOT EXISTS workbench_state (
    employee_id       TEXT PRIMARY KEY,
    is_starred        INTEGER NOT NULL DEFAULT 0,   -- 0/1
    last_read_msg_id  TEXT,
    updated_at        TEXT NOT NULL
);

-- P08 知识库本地元数据
CREATE TABLE IF NOT EXISTS knowledge_bases (
    kb_id        TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    doc_count    INTEGER NOT NULL DEFAULT 0,
    size_kb      INTEGER NOT NULL DEFAULT 0,
    source_type  TEXT NOT NULL DEFAULT 'upload',
    sync_status  TEXT NOT NULL DEFAULT 'idle',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

-- P08 知识库文档
CREATE TABLE IF NOT EXISTS knowledge_documents (
    doc_id        TEXT PRIMARY KEY,
    kb_id         TEXT NOT NULL REFERENCES knowledge_bases(kb_id),
    title         TEXT NOT NULL,
    snippet       TEXT NOT NULL DEFAULT '',
    file_path     TEXT NOT NULL DEFAULT '',
    content_type  TEXT NOT NULL DEFAULT 'text/plain',
    size          INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kdocs_kb ON knowledge_documents (kb_id);

-- 文件上传
CREATE TABLE IF NOT EXISTS upload_assets (
    asset_id      TEXT PRIMARY KEY,
    filename      TEXT NOT NULL,
    size          INTEGER NOT NULL DEFAULT 0,
    content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
    file_path     TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

-- P06 群聊
CREATE TABLE IF NOT EXISTS group_conversations (
    conversation_id  TEXT PRIMARY KEY,
    group_name       TEXT NOT NULL,
    archived         INTEGER NOT NULL DEFAULT 0,    -- 0/1
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

-- P06 群聊成员
CREATE TABLE IF NOT EXISTS group_members (
    conversation_id  TEXT NOT NULL REFERENCES group_conversations(conversation_id),
    employee_id      TEXT NOT NULL,
    joined_at        TEXT NOT NULL,
    PRIMARY KEY (conversation_id, employee_id)
);

-- P06 群聊消息
CREATE TABLE IF NOT EXISTS group_messages (
    message_id       TEXT PRIMARY KEY,
    conversation_id  TEXT NOT NULL REFERENCES group_conversations(conversation_id),
    role             TEXT NOT NULL,
    content          TEXT NOT NULL,
    author_id        TEXT,
    author_name      TEXT,
    mentions         TEXT NOT NULL DEFAULT '[]',    -- JSON array of employee_id
    created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gmsg_conv ON group_messages (conversation_id, created_at);
