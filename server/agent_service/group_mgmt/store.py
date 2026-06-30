"""group_mgmt 本地仓储——群聊/成员/消息（SQLite 本地数据面）。

接口 + 内存 + SQLite 三层，对齐 grants/store.py 模式。
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..local_db import LocalDb


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---- 数据对象 ----

@dataclass
class GroupConversation:
    conversation_id: str
    group_name: str
    archived: bool = False
    created_at: str = ""
    updated_at: str = ""


@dataclass
class GroupMember:
    conversation_id: str
    employee_id: str
    joined_at: str = ""


@dataclass
class GroupMessage:
    message_id: str
    conversation_id: str
    role: str
    content: str
    author_id: str | None = None
    author_name: str | None = None
    mentions: list[str] = field(default_factory=list)
    created_at: str = ""


# ---- Repository 接口 ----

class GroupConversationRepository(ABC):
    @abstractmethod
    def create(self, conv: GroupConversation) -> GroupConversation: ...
    @abstractmethod
    def get(self, conversation_id: str) -> GroupConversation | None: ...
    @abstractmethod
    def list_all(self) -> list[GroupConversation]: ...
    @abstractmethod
    def list_active(self) -> list[GroupConversation]: ...  # archived=False
    @abstractmethod
    def update(self, conv: GroupConversation) -> GroupConversation: ...
    @abstractmethod
    def archive(self, conversation_id: str) -> GroupConversation | None: ...


class GroupMemberRepository(ABC):
    @abstractmethod
    def add(self, member: GroupMember) -> GroupMember: ...
    @abstractmethod
    def remove(self, conversation_id: str, employee_id: str) -> bool: ...
    @abstractmethod
    def list_by_conversation(self, conversation_id: str) -> list[GroupMember]: ...
    @abstractmethod
    def is_member(self, conversation_id: str, employee_id: str) -> bool: ...


class GroupMessageRepository(ABC):
    @abstractmethod
    def create(self, msg: GroupMessage) -> GroupMessage: ...
    @abstractmethod
    def list_by_conversation(self, conversation_id: str,
                              cursor: int = 0, limit: int = 50) -> list[GroupMessage]: ...
    @abstractmethod
    def get(self, message_id: str) -> GroupMessage | None: ...


# ---- InMemory 实现 ----

class InMemoryGroupConversationRepository(GroupConversationRepository):
    def __init__(self) -> None:
        self._items: dict[str, GroupConversation] = {}

    def create(self, conv: GroupConversation) -> GroupConversation:
        conv.created_at = _now()
        conv.updated_at = _now()
        self._items[conv.conversation_id] = conv
        return conv

    def get(self, conversation_id: str) -> GroupConversation | None:
        return self._items.get(conversation_id)

    def list_all(self) -> list[GroupConversation]:
        return sorted(self._items.values(), key=lambda c: c.created_at, reverse=True)

    def list_active(self) -> list[GroupConversation]:
        return sorted(
            (c for c in self._items.values() if not c.archived),
            key=lambda c: c.created_at, reverse=True,
        )

    def update(self, conv: GroupConversation) -> GroupConversation:
        conv.updated_at = _now()
        self._items[conv.conversation_id] = conv
        return conv

    def archive(self, conversation_id: str) -> GroupConversation | None:
        conv = self._items.get(conversation_id)
        if conv is None:
            return None
        conv.archived = True
        conv.updated_at = _now()
        return conv


class InMemoryGroupMemberRepository(GroupMemberRepository):
    def __init__(self) -> None:
        self._items: dict[tuple[str, str], GroupMember] = {}

    def add(self, member: GroupMember) -> GroupMember:
        member.joined_at = _now()
        self._items[(member.conversation_id, member.employee_id)] = member
        return member

    def remove(self, conversation_id: str, employee_id: str) -> bool:
        return self._items.pop((conversation_id, employee_id), None) is not None

    def list_by_conversation(self, conversation_id: str) -> list[GroupMember]:
        return sorted(
            (m for (cid, _), m in self._items.items() if cid == conversation_id),
            key=lambda m: m.joined_at,
        )

    def is_member(self, conversation_id: str, employee_id: str) -> bool:
        return (conversation_id, employee_id) in self._items


class InMemoryGroupMessageRepository(GroupMessageRepository):
    def __init__(self) -> None:
        self._items: dict[str, GroupMessage] = {}
        self._by_conv: dict[str, list[str]] = {}  # conversation_id → [message_id]

    def create(self, msg: GroupMessage) -> GroupMessage:
        msg.created_at = _now()
        self._items[msg.message_id] = msg
        self._by_conv.setdefault(msg.conversation_id, []).append(msg.message_id)
        return msg

    def list_by_conversation(self, conversation_id: str,
                              cursor: int = 0, limit: int = 50) -> list[GroupMessage]:
        msg_ids = self._by_conv.get(conversation_id, [])
        messages = [self._items[mid] for mid in msg_ids if mid in self._items]
        messages.sort(key=lambda m: m.created_at)
        return messages[cursor:cursor + limit]

    def get(self, message_id: str) -> GroupMessage | None:
        return self._items.get(message_id)


# ---- SQLite 实现 ----

class SqliteGroupConversationRepository(GroupConversationRepository):
    def __init__(self, db: LocalDb) -> None:
        self._db = db

    def create(self, conv: GroupConversation) -> GroupConversation:
        now = _now()
        self._db.execute(
            "INSERT INTO group_conversations (conversation_id, group_name, archived, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (conv.conversation_id, conv.group_name, int(conv.archived), now, now),
        )
        conv.created_at = now
        conv.updated_at = now
        return conv

    def get(self, conversation_id: str) -> GroupConversation | None:
        row = self._db.query_one(
            "SELECT * FROM group_conversations WHERE conversation_id = ?", (conversation_id,)
        )
        return self._row_to_conv(row) if row else None

    def list_all(self) -> list[GroupConversation]:
        rows = self._db.query("SELECT * FROM group_conversations ORDER BY created_at DESC")
        return [self._row_to_conv(r) for r in rows]

    def list_active(self) -> list[GroupConversation]:
        rows = self._db.query(
            "SELECT * FROM group_conversations WHERE archived = 0 ORDER BY created_at DESC"
        )
        return [self._row_to_conv(r) for r in rows]

    def update(self, conv: GroupConversation) -> GroupConversation:
        now = _now()
        self._db.execute(
            "UPDATE group_conversations SET group_name = ?, archived = ?, updated_at = ? "
            "WHERE conversation_id = ?",
            (conv.group_name, int(conv.archived), now, conv.conversation_id),
        )
        conv.updated_at = now
        return conv

    def archive(self, conversation_id: str) -> GroupConversation | None:
        conv = self.get(conversation_id)
        if conv is None:
            return None
        conv.archived = True
        return self.update(conv)

    @staticmethod
    def _row_to_conv(row) -> GroupConversation:
        return GroupConversation(
            conversation_id=row["conversation_id"],
            group_name=row["group_name"],
            archived=bool(row["archived"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class SqliteGroupMemberRepository(GroupMemberRepository):
    def __init__(self, db: LocalDb) -> None:
        self._db = db

    def add(self, member: GroupMember) -> GroupMember:
        now = _now()
        self._db.execute(
            "INSERT INTO group_members (conversation_id, employee_id, joined_at) VALUES (?, ?, ?)",
            (member.conversation_id, member.employee_id, now),
        )
        member.joined_at = now
        return member

    def remove(self, conversation_id: str, employee_id: str) -> bool:
        self._db.execute(
            "DELETE FROM group_members WHERE conversation_id = ? AND employee_id = ?",
            (conversation_id, employee_id),
        )
        return True

    def list_by_conversation(self, conversation_id: str) -> list[GroupMember]:
        rows = self._db.query(
            "SELECT * FROM group_members WHERE conversation_id = ? ORDER BY joined_at",
            (conversation_id,),
        )
        return [self._row_to_member(r) for r in rows]

    def is_member(self, conversation_id: str, employee_id: str) -> bool:
        row = self._db.query_one(
            "SELECT 1 FROM group_members WHERE conversation_id = ? AND employee_id = ?",
            (conversation_id, employee_id),
        )
        return row is not None

    @staticmethod
    def _row_to_member(row) -> GroupMember:
        return GroupMember(
            conversation_id=row["conversation_id"],
            employee_id=row["employee_id"],
            joined_at=row["joined_at"],
        )


class SqliteGroupMessageRepository(GroupMessageRepository):
    def __init__(self, db: LocalDb) -> None:
        self._db = db

    def create(self, msg: GroupMessage) -> GroupMessage:
        now = _now()
        self._db.execute(
            "INSERT INTO group_messages (message_id, conversation_id, role, content, "
            "author_id, author_name, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (msg.message_id, msg.conversation_id, msg.role, msg.content,
             msg.author_id, msg.author_name, json.dumps(msg.mentions), now),
        )
        msg.created_at = now
        return msg

    def list_by_conversation(self, conversation_id: str,
                              cursor: int = 0, limit: int = 50) -> list[GroupMessage]:
        rows = self._db.query(
            "SELECT * FROM group_messages WHERE conversation_id = ? "
            "ORDER BY created_at LIMIT ? OFFSET ?",
            (conversation_id, limit, cursor),
        )
        return [self._row_to_msg(r) for r in rows]

    def get(self, message_id: str) -> GroupMessage | None:
        row = self._db.query_one("SELECT * FROM group_messages WHERE message_id = ?", (message_id,))
        return self._row_to_msg(row) if row else None

    @staticmethod
    def _row_to_msg(row) -> GroupMessage:
        return GroupMessage(
            message_id=row["message_id"],
            conversation_id=row["conversation_id"],
            role=row["role"],
            content=row["content"],
            author_id=row["author_id"],
            author_name=row["author_name"],
            mentions=json.loads(row["mentions"]),
            created_at=row["created_at"],
        )
