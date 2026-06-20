"""本地主链仓储（A1）。

接口 + 内存实现。**agent 本地库**：用户端轻量本地库（CLAUDE/AGENTS §12），真实
持久化（SQLite/本地 PG）由后续接入替换实现，接口形状不变。Manager 多租户 RLS 底座
（shared/db）不适用本端——用户端单租户本地库，无 tenant 路由。

只读不存在的资源抛 shared.errors.NotFound（统一 problem+json）。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timezone

from shared.contracts.enums import ConversationState
from shared.errors import NotFound

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
