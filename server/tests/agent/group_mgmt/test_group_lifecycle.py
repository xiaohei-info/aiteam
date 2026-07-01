"""群聊生命周期测试——创建/更新/归档/成员/消息（#267 + AITEAM-274）。"""

import asyncio

from agent_service.group_mgmt.store import (
    InMemoryGroupConversationRepository,
    InMemoryGroupMemberRepository,
    InMemoryGroupMessageRepository,
)
from agent_service.group_mgmt.service import GroupMgmtService


def _make_service():
    conv = InMemoryGroupConversationRepository()
    members = InMemoryGroupMemberRepository()
    msgs = InMemoryGroupMessageRepository()
    return GroupMgmtService(conv_store=conv, member_store=members, msg_store=msgs), conv, members, msgs


class TestGroupCreate:
    def test_create_group_persists_and_adds_members(self):
        svc, conv_store, member_store, _ = _make_service()
        created = svc.create_group("技术讨论组", ["emp-1", "emp-2"])
        assert created.conversation_id
        assert created.group_name == "技术讨论组"
        # Verify persistence
        stored = conv_store.get(created.conversation_id)
        assert stored is not None
        assert stored.group_name == "技术讨论组"
        # Verify members
        members = member_store.list_by_conversation(created.conversation_id)
        assert len(members) == 2
        member_ids = {m.employee_id for m in members}
        assert member_ids == {"emp-1", "emp-2"}

    def test_create_group_with_empty_members_still_works(self):
        svc, conv_store, member_store, _ = _make_service()
        created = svc.create_group("空群", [])
        assert created.conversation_id
        members = member_store.list_by_conversation(created.conversation_id)
        assert members == []


class TestGroupListAndDetail:
    def test_list_groups_returns_active_only(self):
        svc, conv_store, _, _ = _make_service()
        svc.create_group("群A", ["emp-1"])
        svc.create_group("群B", ["emp-2"])
        groups = svc.list_groups()
        assert len(groups) == 2

    def test_archived_groups_not_in_list(self):
        svc, conv_store, _, _ = _make_service()
        g = svc.create_group("群A", ["emp-1"])
        svc.archive_group(g.conversation_id)
        groups = svc.list_groups()
        assert len(groups) == 0

    def test_get_group_returns_detail(self):
        svc, _, _, _ = _make_service()
        g = svc.create_group("群A", ["emp-1"])
        found = svc.get_group(g.conversation_id)
        assert found is not None
        assert found.group_name == "群A"

    def test_get_group_missing_returns_none(self):
        svc, _, _, _ = _make_service()
        assert svc.get_group("nonexistent") is None


class TestGroupUpdate:
    def test_update_group_name(self):
        svc, _, _, _ = _make_service()
        g = svc.create_group("旧名称", ["emp-1"])
        updated = svc.update_group(g.conversation_id, group_name="新名称")
        assert updated is not None
        assert updated.group_name == "新名称"

    def test_update_missing_group_returns_none(self):
        svc, _, _, _ = _make_service()
        assert svc.update_group("nonexistent", group_name="x") is None


class TestGroupArchive:
    def test_archive_group_sets_archived_flag(self):
        svc, conv_store, _, _ = _make_service()
        g = svc.create_group("群A", ["emp-1"])
        archived = svc.archive_group(g.conversation_id)
        assert archived is not None
        assert archived.archived is True
        # Verify in store
        stored = conv_store.get(g.conversation_id)
        assert stored is not None
        assert stored.archived is True

    def test_archive_missing_returns_none(self):
        svc, _, _, _ = _make_service()
        assert svc.archive_group("nonexistent") is None

    def test_cannot_send_message_to_archived_group(self):
        svc, _, _, _ = _make_service()
        g = svc.create_group("群A", ["emp-1"])
        svc.archive_group(g.conversation_id)
        msg = asyncio.run(svc.send_message(g.conversation_id, "hello"))
        assert msg is None


class TestGroupMembers:
    def test_add_member_to_group(self):
        svc, _, member_store, _ = _make_service()
        g = svc.create_group("群A", ["emp-1"])
        ok = svc.add_member(g.conversation_id, "emp-2")
        assert ok is True
        members = member_store.list_by_conversation(g.conversation_id)
        assert len(members) == 2

    def test_add_duplicate_member_is_idempotent(self):
        svc, _, member_store, _ = _make_service()
        g = svc.create_group("群A", ["emp-1"])
        svc.add_member(g.conversation_id, "emp-1")  # duplicate
        members = member_store.list_by_conversation(g.conversation_id)
        assert len(members) == 1

    def test_remove_member(self):
        svc, _, member_store, _ = _make_service()
        g = svc.create_group("群A", ["emp-1", "emp-2"])
        svc.remove_member(g.conversation_id, "emp-1")
        members = member_store.list_by_conversation(g.conversation_id)
        assert len(members) == 1
        assert members[0].employee_id == "emp-2"

    def test_list_members(self):
        svc, _, _, _ = _make_service()
        g = svc.create_group("群A", ["emp-1", "emp-2"])
        members = svc.list_members(g.conversation_id)
        assert len(members) == 2


class TestGroupMessages:
    def test_send_message_persists(self):
        svc, _, _, msg_store = _make_service()
        g = svc.create_group("群A", ["emp-1"])
        msg = asyncio.run(svc.send_message(g.conversation_id, "大家好", author_id="emp-1", author_name="Alice"))
        assert msg is not None
        assert msg.message_id
        assert msg.content == "大家好"
        assert msg.role == "user"
        assert msg.author_id == "emp-1"
        assert msg.author_name == "Alice"
        # Verify persistence
        stored = msg_store.get(msg.message_id)
        assert stored is not None
        assert stored.content == "大家好"

    def test_send_message_with_mentions(self):
        svc, _, _, _ = _make_service()
        g = svc.create_group("群A", ["emp-1"])
        msg = asyncio.run(svc.send_message(g.conversation_id, "@emp-2 你好", mentions=["emp-2"]))
        assert msg is not None
        assert msg.mentions == ["emp-2"]

    def test_list_messages_returns_in_order(self):
        svc, _, _, _ = _make_service()
        g = svc.create_group("群A", ["emp-1"])
        asyncio.run(svc.send_message(g.conversation_id, "第一条"))
        asyncio.run(svc.send_message(g.conversation_id, "第二条"))
        asyncio.run(svc.send_message(g.conversation_id, "第三条"))
        msgs = svc.list_messages(g.conversation_id, cursor=0)
        assert len(msgs) == 3
        assert [m.content for m in msgs] == ["第一条", "第二条", "第三条"]

    def test_list_messages_with_cursor(self):
        svc, _, _, _ = _make_service()
        g = svc.create_group("群A", ["emp-1"])
        for i in range(5):
            asyncio.run(svc.send_message(g.conversation_id, f"msg{i}"))
        msgs = svc.list_messages(g.conversation_id, cursor=2)
        # InMemory store returns cursor-based slicing
        assert len(msgs) == 3  # 50 limit, cursor=2 skips first 2
