-- Agent raw runtime event 本地归档（#179 / D6）。
-- 仅本地脱敏受控存储，设保留期并清理，不跨端、不外泄前端。

CREATE TABLE IF NOT EXISTS raw_events (
    event_id    TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    type        TEXT NOT NULL,
    source      TEXT NOT NULL,
    timestamp   TEXT NOT NULL,        -- ISO datetime
    payload     TEXT NOT NULL,        -- 脱敏后 JSON
    archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_raw_events_run ON raw_events (run_id, seq);
CREATE INDEX IF NOT EXISTS idx_raw_events_archived ON raw_events (archived_at);
