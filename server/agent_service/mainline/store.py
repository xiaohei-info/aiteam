"""本地主链仓储（A1）。

接口 + 内存实现。**agent 本地库**：用户端轻量本地库（CLAUDE/AGENTS §12），真实
持久化（SQLite/本地 PG）由后续接入替换实现，接口形状不变。Manager 多租户 RLS 底座
（shared/db）不适用本端——用户端单租户本地库，无 tenant 路由。

只读不存在的资源抛 shared.errors.NotFound（统一 problem+json）。
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from datetime import datetime, timezone

from shared.contracts.enums import ConversationState
from shared.errors import NotFound

from ..local_db import LocalDb
from .models import Conversation, Message, Run, RunStatus, Task, TaskStatus


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ConversationRepository(ABC):
    @abstractmethod
    def create(self, conversation: Conversation) -> Conversation: ...
    @abstractmethod
    def get(self, conversation_id: str) -> Conversation: ...
    @abstractmethod
    def list(self) -> list[Conversation]: ...
    @abstractmethod
    def set_state(self, conversation_id: str, state: ConversationState) -> Conversation: ...


class MessageRepository(ABC):
    @abstractmethod
    def add(self, message: Message) -> Message: ...
    @abstractmethod
    def list(self, conversation_id: str) -> list[Message]: ...


class RunRepository(ABC):
    @abstractmethod
    def create(self, run: Run) -> Run: ...
    @abstractmethod
    def get(self, run_id: str) -> Run: ...
    @abstractmethod
    def list(self, conversation_id: str) -> list[Run]: ...
    @abstractmethod
    def finalize(self, run_id: str, status: RunStatus, *,
                 session_id: str | None, error: str | None, usage: dict | None) -> Run: ...


class TaskRepository(ABC):
    @abstractmethod
    def create(self, task: Task) -> Task: ...
    @abstractmethod
    def get(self, task_id: str) -> Task: ...
    @abstractmethod
    def list(self, conversation_id: str) -> list[Task]: ...
    @abstractmethod
    def set_status(self, task_id: str, status: TaskStatus) -> Task: ...


# ---- 内存实现（本地库占位；接口稳定，真实持久化后续替换）----

class InMemoryConversationRepository(ConversationRepository):
    def __init__(self) -> None:
        self._items: dict[str, Conversation] = {}

    def create(self, conversation: Conversation) -> Conversation:
        self._items[conversation.id] = conversation
        return conversation

    def get(self, conversation_id: str) -> Conversation:
        item = self._items.get(conversation_id)
        if item is None:
            raise NotFound(f"conversation {conversation_id} not found")
        return item

    def list(self) -> list[Conversation]:
        return sorted(self._items.values(), key=lambda c: c.created_at)

    def set_state(self, conversation_id: str, state: ConversationState) -> Conversation:
        item = self.get(conversation_id)
        updated = item.model_copy(update={"state": state, "updated_at": _now()})
        self._items[conversation_id] = updated
        return updated


class InMemoryMessageRepository(MessageRepository):
    def __init__(self) -> None:
        self._items: dict[str, list[Message]] = {}

    def add(self, message: Message) -> Message:
        self._items.setdefault(message.conversation_id, []).append(message)
        return message

    def list(self, conversation_id: str) -> list[Message]:
        return list(self._items.get(conversation_id, []))


class InMemoryRunRepository(RunRepository):
    def __init__(self) -> None:
        self._items: dict[str, Run] = {}

    def create(self, run: Run) -> Run:
        self._items[run.id] = run
        return run

    def get(self, run_id: str) -> Run:
        item = self._items.get(run_id)
        if item is None:
            raise NotFound(f"run {run_id} not found")
        return item

    def list(self, conversation_id: str) -> list[Run]:
        return sorted(
            (r for r in self._items.values() if r.conversation_id == conversation_id),
            key=lambda r: r.created_at,
        )

    def finalize(self, run_id: str, status: RunStatus, *,
                 session_id: str | None, error: str | None, usage: dict | None) -> Run:
        item = self.get(run_id)
        updated = item.model_copy(update={
            "status": status,
            "session_id": session_id,
            "error": error,
            "usage": usage,
            "updated_at": _now(),
        })
        self._items[run_id] = updated
        return updated


class InMemoryTaskRepository(TaskRepository):
    def __init__(self) -> None:
        self._items: dict[str, Task] = {}

    def create(self, task: Task) -> Task:
        self._items[task.id] = task
        return task

    def get(self, task_id: str) -> Task:
        item = self._items.get(task_id)
        if item is None:
            raise NotFound(f"task {task_id} not found")
        return item

    def list(self, conversation_id: str) -> list[Task]:
        return sorted(
            (t for t in self._items.values() if t.conversation_id == conversation_id),
            key=lambda t: t.created_at,
        )

    def set_status(self, task_id: str, status: TaskStatus) -> Task:
        item = self.get(task_id)
        updated = item.model_copy(update={"status": status, "updated_at": _now()})
        self._items[task_id] = updated
        return updated


# ---- SQLite 实现（agent 本地库；与内存实现行为等价，重启不丢）----
#
# 列表序 `ORDER BY created_at, rowid`：rowid 兜底插入序，对齐内存实现的 append 顺序。
# datetime ↔ ISO 字符串；usage(dict) ↔ JSON 文本。列名与 pydantic 字段同名，故可直接 **dict(row)。

def _iso(dt: datetime) -> str:
    return dt.isoformat()


class SqliteConversationRepository(ConversationRepository):
    def __init__(self, db: LocalDb) -> None:
        self._db = db

    def create(self, conversation: Conversation) -> Conversation:
        self._db.execute(
            "INSERT INTO conversations (id, title, state, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (conversation.id, conversation.title, conversation.state.value,
             _iso(conversation.created_at), _iso(conversation.updated_at)),
        )
        return conversation

    def get(self, conversation_id: str) -> Conversation:
        row = self._db.query_one("SELECT * FROM conversations WHERE id = ?", (conversation_id,))
        if row is None:
            raise NotFound(f"conversation {conversation_id} not found")
        return Conversation(**dict(row))

    def list(self) -> list[Conversation]:
        rows = self._db.query("SELECT * FROM conversations ORDER BY created_at, rowid")
        return [Conversation(**dict(r)) for r in rows]

    def set_state(self, conversation_id: str, state: ConversationState) -> Conversation:
        self.get(conversation_id)  # 存在性校验 -> NotFound
        self._db.execute(
            "UPDATE conversations SET state = ?, updated_at = ? WHERE id = ?",
            (state.value, _iso(_now()), conversation_id),
        )
        return self.get(conversation_id)


class SqliteMessageRepository(MessageRepository):
    def __init__(self, db: LocalDb) -> None:
        self._db = db

    def add(self, message: Message) -> Message:
        self._db.execute(
            "INSERT INTO messages (id, conversation_id, role, content, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (message.id, message.conversation_id, message.role.value,
             message.content, _iso(message.created_at)),
        )
        return message

    def list(self, conversation_id: str) -> list[Message]:
        rows = self._db.query(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid",
            (conversation_id,),
        )
        return [Message(**dict(r)) for r in rows]


class SqliteRunRepository(RunRepository):
    def __init__(self, db: LocalDb) -> None:
        self._db = db

    @staticmethod
    def _row_to_run(row) -> Run:
        data = dict(row)
        data["usage"] = json.loads(data["usage"]) if data["usage"] is not None else None
        return Run(**data)

    def create(self, run: Run) -> Run:
        self._db.execute(
            "INSERT INTO runs (id, conversation_id, status, session_id, error, usage, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (run.id, run.conversation_id, run.status.value, run.session_id, run.error,
             json.dumps(run.usage) if run.usage is not None else None,
             _iso(run.created_at), _iso(run.updated_at)),
        )
        return run

    def get(self, run_id: str) -> Run:
        row = self._db.query_one("SELECT * FROM runs WHERE id = ?", (run_id,))
        if row is None:
            raise NotFound(f"run {run_id} not found")
        return self._row_to_run(row)

    def list(self, conversation_id: str) -> list[Run]:
        rows = self._db.query(
            "SELECT * FROM runs WHERE conversation_id = ? ORDER BY created_at, rowid",
            (conversation_id,),
        )
        return [self._row_to_run(r) for r in rows]

    def finalize(self, run_id: str, status: RunStatus, *,
                 session_id: str | None, error: str | None, usage: dict | None) -> Run:
        self.get(run_id)  # 存在性校验 -> NotFound
        self._db.execute(
            "UPDATE runs SET status = ?, session_id = ?, error = ?, usage = ?, updated_at = ? "
            "WHERE id = ?",
            (status.value, session_id, error,
             json.dumps(usage) if usage is not None else None, _iso(_now()), run_id),
        )
        return self.get(run_id)


class SqliteTaskRepository(TaskRepository):
    def __init__(self, db: LocalDb) -> None:
        self._db = db

    def create(self, task: Task) -> Task:
        self._db.execute(
            "INSERT INTO tasks (id, conversation_id, run_id, title, status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (task.id, task.conversation_id, task.run_id, task.title, task.status.value,
             _iso(task.created_at), _iso(task.updated_at)),
        )
        return task

    def get(self, task_id: str) -> Task:
        row = self._db.query_one("SELECT * FROM tasks WHERE id = ?", (task_id,))
        if row is None:
            raise NotFound(f"task {task_id} not found")
        return Task(**dict(row))

    def list(self, conversation_id: str) -> list[Task]:
        rows = self._db.query(
            "SELECT * FROM tasks WHERE conversation_id = ? ORDER BY created_at, rowid",
            (conversation_id,),
        )
        return [Task(**dict(r)) for r in rows]

    def set_status(self, task_id: str, status: TaskStatus) -> Task:
        self.get(task_id)  # 存在性校验 -> NotFound
        self._db.execute(
            "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
            (status.value, _iso(_now()), task_id),
        )
        return self.get(task_id)
