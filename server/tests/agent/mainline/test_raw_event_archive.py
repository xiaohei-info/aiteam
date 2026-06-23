"""#179 验收：raw event 归档落库 + 脱敏 + 保留期。

覆盖：
- SQLite 持久化（重启不丢）
- 敏感字段脱敏（api_key / token / password / credential 等）
- 保留期清理（超期自动删除）
- 归档只写不对外读（无 read_*/list_* 公开接口）
"""

from datetime import datetime, timedelta, timezone

from agent_service.local_db import connect
from agent_service.mainline.timeline import SqliteRawEventArchive
from shared.contracts.events import AgentRuntimeEvent


def _rt(event_id="e1", run_id="r1", seq=1, payload=None) -> AgentRuntimeEvent:
    return AgentRuntimeEvent(
        event_id=event_id,
        run_id=run_id,
        seq=seq,
        type="status",
        source="fake",
        timestamp=datetime.now(timezone.utc),
        payload=payload or {},
    )


def test_sqlite_archive_persists_across_restarts():
    """验收：raw event 落 SQLite，重启后仍在。"""
    db = connect(":memory:")
    db.execute(
        "CREATE TABLE IF NOT EXISTS raw_events ("
        "event_id TEXT PRIMARY KEY, run_id TEXT, seq INTEGER, type TEXT, "
        "source TEXT, timestamp TEXT, payload TEXT, archived_at TEXT DEFAULT (datetime('now')))"
    )
    archive = SqliteRawEventArchive(db)
    archive.archive(_rt(event_id="e1", payload={"foo": "bar"}))
    assert archive._debug_count() == 1

    # 模拟重启：新建归档实例，复用同一 DB 连接
    archive2 = SqliteRawEventArchive(db)
    assert archive2._debug_count() == 1


def test_sanitize_removes_api_keys():
    """脱敏：api_key / apikey / api-key 等敏感字段不落库。"""
    db = connect(":memory:")
    db.execute(
        "CREATE TABLE IF NOT EXISTS raw_events ("
        "event_id TEXT PRIMARY KEY, run_id TEXT, seq INTEGER, type TEXT, "
        "source TEXT, timestamp TEXT, payload TEXT, archived_at TEXT DEFAULT (datetime('now')))"
    )
    archive = SqliteRawEventArchive(db)
    archive.archive(_rt(payload={
        "api_key": "secret123",
        "apiKey": "secret456",
        "api-key": "secret789",
        "safe_field": "ok",
    }))

    row = db.query_one("SELECT payload FROM raw_events WHERE event_id = ?", ("e1",))
    import json
    stored = json.loads(row["payload"])
    # 敏感字段被移除
    assert "api_key" not in stored
    assert "apiKey" not in stored
    assert "api-key" not in stored
    # 安全字段保留
    assert stored["safe_field"] == "ok"


def test_sanitize_removes_tokens_and_secrets():
    """脱敏：token / secret / password / credential 等敏感字段不落库。"""
    db = connect(":memory:")
    db.execute(
        "CREATE TABLE IF NOT EXISTS raw_events ("
        "event_id TEXT PRIMARY KEY, run_id TEXT, seq INTEGER, type TEXT, "
        "source TEXT, timestamp TEXT, payload TEXT, archived_at TEXT DEFAULT (datetime('now')))"
    )
    archive = SqliteRawEventArchive(db)
    archive.archive(_rt(payload={
        "token": "tok123",
        "access_token": "tok456",
        "bearer_token": "tok789",
        "secret": "sec123",
        "client_secret": "sec456",
        "password": "pass123",
        "credential": "cred123",
        "private_key": "key123",
        "data": "safe",
    }))

    row = db.query_one("SELECT payload FROM raw_events WHERE event_id = ?", ("e1",))
    import json
    stored = json.loads(row["payload"])
    # 所有敏感字段被移除
    sensitive = ["token", "access_token", "bearer_token", "secret", "client_secret",
                 "password", "credential", "private_key"]
    for field in sensitive:
        assert field not in stored, f"{field} should be sanitized"
    # 安全字段保留
    assert stored["data"] == "safe"


def test_sanitize_recursive_nested_dicts():
    """脱敏：递归处理嵌套 dict，移除所有层级的敏感字段。"""
    db = connect(":memory:")
    db.execute(
        "CREATE TABLE IF NOT EXISTS raw_events ("
        "event_id TEXT PRIMARY KEY, run_id TEXT, seq INTEGER, type TEXT, "
        "source TEXT, timestamp TEXT, payload TEXT, archived_at TEXT DEFAULT (datetime('now')))"
    )
    archive = SqliteRawEventArchive(db)
    archive.archive(_rt(payload={
        "outer": "safe",
        "nested": {
            "api_key": "secret1",
            "data": "ok",
            "deep": {
                "password": "secret2",
                "value": "preserved",
            },
        },
    }))

    row = db.query_one("SELECT payload FROM raw_events WHERE event_id = ?", ("e1",))
    import json
    stored = json.loads(row["payload"])
    assert stored["outer"] == "safe"
    assert "api_key" not in stored["nested"]
    assert stored["nested"]["data"] == "ok"
    assert "password" not in stored["nested"]["deep"]
    assert stored["nested"]["deep"]["value"] == "preserved"


def test_sanitize_handles_lists_with_dicts():
    """脱敏：处理列表中的嵌套 dict。"""
    db = connect(":memory:")
    db.execute(
        "CREATE TABLE IF NOT EXISTS raw_events ("
        "event_id TEXT PRIMARY KEY, run_id TEXT, seq INTEGER, type TEXT, "
        "source TEXT, timestamp TEXT, payload TEXT, archived_at TEXT DEFAULT (datetime('now')))"
    )
    archive = SqliteRawEventArchive(db)
    archive.archive(_rt(payload={
        "items": [
            {"name": "item1", "secret": "hide1"},
            {"name": "item2", "token": "hide2"},
        ],
    }))

    row = db.query_one("SELECT payload FROM raw_events WHERE event_id = ?", ("e1",))
    import json
    stored = json.loads(row["payload"])
    assert len(stored["items"]) == 2
    assert stored["items"][0]["name"] == "item1"
    assert "secret" not in stored["items"][0]
    assert stored["items"][1]["name"] == "item2"
    assert "token" not in stored["items"][1]


def test_cleanup_expired_removes_old_events():
    """保留期清理：超期归档事件被删除。"""
    db = connect(":memory:")
    db.execute(
        "CREATE TABLE IF NOT EXISTS raw_events ("
        "event_id TEXT PRIMARY KEY, run_id TEXT, seq INTEGER, type TEXT, "
        "source TEXT, timestamp TEXT, payload TEXT, archived_at TEXT)"
    )

    # 插入过期事件（10 天前）
    old_time = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    db.execute(
        "INSERT INTO raw_events (event_id, run_id, seq, type, source, timestamp, payload, archived_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("old", "r1", 1, "status", "fake", old_time, "{}", old_time),
    )

    # 插入新事件（1 天前）
    recent_time = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    db.execute(
        "INSERT INTO raw_events (event_id, run_id, seq, type, source, timestamp, payload, archived_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("recent", "r1", 2, "status", "fake", recent_time, "{}", recent_time),
    )

    archive = SqliteRawEventArchive(db, retention_days=7)
    assert archive._debug_count() == 2

    # 清理超期（保留期 7 天）
    deleted = archive.cleanup_expired()
    assert deleted == 1
    assert archive._debug_count() == 1

    # 确认只保留新事件
    remaining = db.query_one("SELECT event_id FROM raw_events")
    assert remaining["event_id"] == "recent"


def test_archive_write_only_no_public_read():
    """归档只写不对外读：无 read_*/list_* 公开接口。"""
    db = connect(":memory:")
    db.execute(
        "CREATE TABLE IF NOT EXISTS raw_events ("
        "event_id TEXT PRIMARY KEY, run_id TEXT, seq INTEGER, type TEXT, "
        "source TEXT, timestamp TEXT, payload TEXT, archived_at TEXT DEFAULT (datetime('now')))"
    )
    archive = SqliteRawEventArchive(db)
    archive.archive(_rt())

    # 只暴露 archive + cleanup_expired（+ 调试用 _debug_count）
    public = [a for a in dir(archive) if not a.startswith("_")]
    assert set(public) == {"archive", "cleanup_expired"}
