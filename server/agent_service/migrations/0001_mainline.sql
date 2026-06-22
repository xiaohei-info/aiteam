-- Agent 本地主链持久化（#158）。datetime 存 ISO 字符串，dict 存 JSON 文本。
-- 列表序由 (created_at, rowid) 决定，rowid 兜底插入序以对齐内存实现。

CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    title      TEXT,
    state      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS runs (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    status          TEXT NOT NULL,
    session_id      TEXT,
    error           TEXT,
    usage           TEXT,            -- JSON or NULL
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_conv ON runs (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    run_id          TEXT,
    title           TEXT NOT NULL,
    status          TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_conv ON tasks (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS timeline_events (
    conversation_id TEXT NOT NULL,
    cursor          INTEGER NOT NULL,
    run_id          TEXT NOT NULL,
    type            TEXT NOT NULL,
    payload         TEXT NOT NULL,   -- JSON
    created_at      TEXT NOT NULL,
    PRIMARY KEY (conversation_id, cursor)
);
