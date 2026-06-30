"""group_mgmt SQLite store 集成测试（#267）。验证迁移 0003 表创建 + 读写。"""

import tempfile
from pathlib import Path

from agent_service.local_db import LocalDb, apply_migrations, connect
from agent_service.group_mgmt.store import (
    GroupConversation,
    GroupMember,
    GroupMessage,
    SqliteGroupConversationRepository,
    SqliteGroupMemberRepository,
    SqliteGroupMessageRepository,
)


def _make_db():
    d = tempfile.mkdtemp()
    db_path = str(Path(d) / "test.db")
    db = connect(db_path)
    apply_migrations(db)
    return db


def _create_conv(db):
    """创建父记录（FK 约束需要）。"""
    repo = SqliteGroupConversationRepository(db)
    return repo.create(GroupConversation(conversation_id="c1", group_name="测试群"))


class TestSqliteGroupConversation:
    def test_create_and_get(self):
        db = _make_db()
        repo = SqliteGroupConversationRepository(db)
        conv = repo.create(GroupConversation(conversation_id="c1", group_name="测试群"))
        assert conv.conversation_id == "c1"
        stored = repo.get("c1")
        assert stored is not None
        assert stored.group_name == "测试群"

    def test_list_active_excludes_archived(self):
        db = _make_db()
        repo = SqliteGroupConversationRepository(db)
        repo.create(GroupConversation(conversation_id="c1", group_name="活跃群"))
        repo.create(GroupConversation(conversation_id="c2", group_name="归档群"))
        repo.archive("c2")
        active = repo.list_active()
        assert len(active) == 1
        assert active[0].conversation_id == "c1"

    def test_update_and_archive(self):
        db = _make_db()
        repo = SqliteGroupConversationRepository(db)
        repo.create(GroupConversation(conversation_id="c1", group_name="原名"))
        conv = repo.get("c1")
        assert conv is not None
        conv.group_name = "新名"
        repo.update(conv)
        stored = repo.get("c1")
        assert stored is not None
        assert stored.group_name == "新名"


class TestSqliteGroupMember:
    def test_add_and_list(self):
        db = _make_db()
        _create_conv(db)  # FK 父行
        repo = SqliteGroupMemberRepository(db)
        repo.add(GroupMember(conversation_id="c1", employee_id="emp-1"))
        repo.add(GroupMember(conversation_id="c1", employee_id="emp-2"))
        members = repo.list_by_conversation("c1")
        assert len(members) == 2

    def test_remove_and_is_member(self):
        db = _make_db()
        _create_conv(db)  # FK 父行
        repo = SqliteGroupMemberRepository(db)
        repo.add(GroupMember(conversation_id="c1", employee_id="emp-1"))
        assert repo.is_member("c1", "emp-1") is True
        repo.remove("c1", "emp-1")
        assert repo.is_member("c1", "emp-1") is False


class TestSqliteGroupMessage:
    def test_create_and_list(self):
        db = _make_db()
        _create_conv(db)  # FK 父行
        repo = SqliteGroupMessageRepository(db)
        repo.create(GroupMessage(
            message_id="m1", conversation_id="c1", role="user",
            content="Hello", author_id="emp-1", mentions=["emp-2"],
        ))
        repo.create(GroupMessage(
            message_id="m2", conversation_id="c1", role="assistant",
            content="Hi", author_id="emp-2", mentions=[],
        ))
        msgs = repo.list_by_conversation("c1")
        assert len(msgs) == 2

    def test_list_with_cursor(self):
        db = _make_db()
        _create_conv(db)  # FK 父行
        repo = SqliteGroupMessageRepository(db)
        for i in range(10):
            repo.create(GroupMessage(
                message_id=f"m{i}", conversation_id="c1", role="user",
                content=f"msg{i}",
            ))
        msgs = repo.list_by_conversation("c1", cursor=5, limit=3)
        assert len(msgs) == 3

    def test_get_by_id(self):
        db = _make_db()
        _create_conv(db)  # FK 父行
        repo = SqliteGroupMessageRepository(db)
        repo.create(GroupMessage(message_id="m1", conversation_id="c1", role="user", content="test"))
        msg = repo.get("m1")
        assert msg is not None
        assert msg.content == "test"
        assert repo.get("nonexistent") is None
