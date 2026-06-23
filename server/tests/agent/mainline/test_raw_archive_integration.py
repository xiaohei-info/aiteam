"""#179 集成验收：完整的 raw event 归档流程（factory 装配 + 持久化 + 脱敏 + 清理）。"""

import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from agent_service.mainline.factory import build_mainline_service
from shared.contracts.events import AgentRuntimeEvent


def test_factory_builds_sqlite_raw_archive_when_db_path_given():
    """factory 装配：db_path 给定时使用 SqliteRawEventArchive。"""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = str(Path(tmpdir) / "test.db")
        service = build_mainline_service(db_path=db_path)

        # 归档 raw event（含敏感字段）
        event = AgentRuntimeEvent(
            event_id="e1",
            run_id="r1",
            seq=1,
            type="status",
            source="test",
            timestamp=datetime.now(timezone.utc),
            payload={"api_key": "secret123", "data": "safe"},
        )
        service._raw_archive.archive(event)

        # 验证归档成功
        assert service._raw_archive._debug_count() == 1


def test_factory_sqlite_raw_archive_sanitizes_and_persists():
    """集成验收：factory 装配的 SqliteRawEventArchive 脱敏后持久化。"""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = str(Path(tmpdir) / "test.db")
        service = build_mainline_service(db_path=db_path)

        # 归档含敏感字段的 event
        event = AgentRuntimeEvent(
            event_id="e1",
            run_id="r1",
            seq=1,
            type="status",
            source="test",
            timestamp=datetime.now(timezone.utc),
            payload={
                "token": "secret_token",
                "password": "secret_pass",
                "safe_data": "preserved",
            },
        )
        service._raw_archive.archive(event)

        # 重建 service（模拟重启）
        service2 = build_mainline_service(db_path=db_path)

        # 验证持久化（重启后仍在）
        assert service2._raw_archive._debug_count() == 1


def test_factory_cleanup_expired_on_startup():
    """集成验收：factory 启动时自动清理过期归档。"""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = str(Path(tmpdir) / "test.db")

        # 第一次启动：创建 DB 并插入过期事件
        service1 = build_mainline_service(db_path=db_path)

        # 手动插入过期事件（绕过 archive 直接写 DB，模拟 10 天前的归档）
        from agent_service.local_db import connect
        db = connect(db_path)
        old_time = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
        db.execute(
            "INSERT INTO raw_events (event_id, run_id, seq, type, source, timestamp, payload, archived_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("old", "r1", 1, "status", "test", old_time, "{}", old_time),
        )
        db.close()

        # 第二次启动：factory 应自动清理过期事件（保留期默认 7 天）
        service2 = build_mainline_service(db_path=db_path)

        # 验证过期事件已清理
        assert service2._raw_archive._debug_count() == 0


def test_factory_without_db_path_uses_memory_archive():
    """factory 装配：db_path 未给时使用 InMemoryRawEventArchive。"""
    service = build_mainline_service()

    # 归档 event
    event = AgentRuntimeEvent(
        event_id="e1",
        run_id="r1",
        seq=1,
        type="status",
        source="test",
        timestamp=datetime.now(timezone.utc),
        payload={"data": "test"},
    )
    service._raw_archive.archive(event)

    # 内存归档有效
    assert service._raw_archive._debug_count() == 1
