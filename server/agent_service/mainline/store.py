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
from shared.errors import Conflict, NotFound

from ..local_db import LocalDb
from .models import (Conversation, Message, Run, RunStatus, RunTriggerType, RunExecutionMode, Task, TaskStatus)


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

    @abstractmethod
    def update_collaboration(
        self,
        conversation_id: str,
        *,
        collaboration_mode: str | None = None,
        orchestration_brief: str | None = None,
        planner_employee_id: str | None = None,
        solution_instance_id: str | None | object = None,
        solution_planner_prompt: str | None = None,
        solution_subtask_prompt: str | None = None,
        solution_aggregate_prompt: str | None = None,
        solution_expert_employee_ids: list[str] | None | object = None,
    ) -> Conversation: ...

    @abstractmethod
    def update_read_status(
        self,
        conversation_id: str,
        *,
        last_read_at: datetime | None = None,
        last_read_message_id: str | None | object = None,
    ) -> Conversation: ...


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
                 session_id: str | None, error: str | None, usage: dict | None,
                 trigger_type: "RunTriggerType | None" = None,
                 execution_mode: "RunExecutionMode | None" = None) -> Run: ...

    @abstractmethod
    def update_status(self, run_id: str, run: Run) -> Run: ...


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

    def update_collaboration(
        self,
        conversation_id: str,
        *,
        collaboration_mode: str | None = None,
        orchestration_brief: str | None = None,
        planner_employee_id: str | None | object = None,
        solution_instance_id: str | None | object = None,
        solution_planner_prompt: str | None = None,
        solution_subtask_prompt: str | None = None,
        solution_aggregate_prompt: str | None = None,
        solution_expert_employee_ids: list[str] | None | object = None,
    ) -> Conversation:
        item = self.get(conversation_id)
        data = item.model_dump()
        if collaboration_mode is not None:
            data["collaboration_mode"] = "orchestrated" if str(collaboration_mode) == "orchestrated" else "free"
        mode = data["collaboration_mode"]
        if mode == "orchestrated":
            if orchestration_brief is not None:
                data["orchestration_brief"] = str(orchestration_brief).strip()
            if not str(data.get("orchestration_brief") or "").strip():
                raise ValueError("orchestration_brief is required when collaboration_mode is orchestrated")
        else:
            data["orchestration_brief"] = ""
        if planner_employee_id is not None:
            value = None if (isinstance(planner_employee_id, str) and not planner_employee_id.strip()) else planner_employee_id
            data["planner_employee_id"] = value
        # 方案实例绑定：仅允许一次（创建时设置，不通过 PATCH 路径覆盖，固定编排语义）。
        if solution_instance_id is not None:
            value = None if (isinstance(solution_instance_id, str) and not solution_instance_id.strip()) else solution_instance_id
            data["solution_instance_id"] = value
        if solution_planner_prompt is not None:
            data["solution_planner_prompt"] = str(solution_planner_prompt)
        if solution_subtask_prompt is not None:
            data["solution_subtask_prompt"] = str(solution_subtask_prompt)
        if solution_aggregate_prompt is not None:
            data["solution_aggregate_prompt"] = str(solution_aggregate_prompt)
        if solution_expert_employee_ids is not None:
            ids = solution_expert_employee_ids if isinstance(solution_expert_employee_ids, list) else []
            prev_ids = data.get("solution_expert_employee_ids")
            if prev_ids and ids and list(prev_ids) != list(ids):
                raise Conflict(
                    f"solution_expert_employee_ids already bound to {list(prev_ids)!r}; cannot rebind"
                )
            data["solution_expert_employee_ids"] = [str(x) for x in ids]
        data["updated_at"] = _now()
        updated = Conversation(**data)
        self._items[conversation_id] = updated
        return updated

    def update_read_status(
        self,
        conversation_id: str,
        *,
        last_read_at: datetime | None = None,
        last_read_message_id: str | None | object = None,
    ) -> Conversation:
        item = self.get(conversation_id)
        data = item.model_dump()
        if last_read_at is not None:
            data["last_read_at"] = last_read_at
        if last_read_message_id is not None:
            value = None if (isinstance(last_read_message_id, str) and not last_read_message_id.strip()) else last_read_message_id
            data["last_read_message_id"] = value
        data["updated_at"] = _now()
        updated = Conversation(**data)
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
                 session_id: str | None, error: str | None, usage: dict | None,
                 trigger_type: RunTriggerType | None = None,
                 execution_mode: RunExecutionMode | None = None) -> Run:
        item = self.get(run_id)
        updated = item.model_copy(update={
            "status": status,
            "session_id": session_id,
            "error": error,
            "usage": usage,
            **({"trigger_type": trigger_type} if trigger_type is not None else {}),
            **({"execution_mode": execution_mode} if execution_mode is not None else {}),
            "updated_at": _now(),
        })
        self._items[run_id] = updated
        return updated

    def update_status(self, run_id: str, run: Run) -> Run:
        item = self.get(run_id)
        updated = item.model_copy(update={
            "status": run.status,
            "trigger_type": run.trigger_type,
            "execution_mode": run.execution_mode,
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
            "INSERT INTO conversations "
            "(id, title, state, collaboration_mode, orchestration_brief, planner_employee_id, entry_employee_id, "
            "last_read_at, last_read_message_id, created_at, updated_at, "
            "solution_instance_id, solution_planner_prompt, solution_subtask_prompt, solution_aggregate_prompt, "
            "solution_expert_employee_ids) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (conversation.id, conversation.title, conversation.state.value,
             conversation.collaboration_mode, conversation.orchestration_brief,
             conversation.planner_employee_id,
             conversation.entry_employee_id,
             _iso(conversation.last_read_at) if conversation.last_read_at is not None else None,
             conversation.last_read_message_id,
             _iso(conversation.created_at), _iso(conversation.updated_at),
             conversation.solution_instance_id,
             conversation.solution_planner_prompt,
             conversation.solution_subtask_prompt,
             conversation.solution_aggregate_prompt,
             json.dumps(conversation.solution_expert_employee_ids)),
        )
        return conversation

    def get(self, conversation_id: str) -> Conversation:
        row = self._db.query_one(
            "SELECT id, title, state, COALESCE(collaboration_mode, 'free') AS collaboration_mode, "
            "COALESCE(orchestration_brief, '') AS orchestration_brief, planner_employee_id, entry_employee_id, "
            "last_read_at, last_read_message_id, created_at, updated_at, "
            "solution_instance_id, "
            "COALESCE(solution_planner_prompt, '') AS solution_planner_prompt, "
            "COALESCE(solution_subtask_prompt, '') AS solution_subtask_prompt, "
            "COALESCE(solution_aggregate_prompt, '') AS solution_aggregate_prompt, "
            "COALESCE(solution_expert_employee_ids, '[]') AS solution_expert_employee_ids "
            "FROM conversations WHERE id = ?",
            (conversation_id,),
        )
        if row is None:
            raise NotFound(f"conversation {conversation_id} not found")
        row = dict(row)
        row["last_read_at"] = datetime.fromisoformat(row["last_read_at"]) if row.get("last_read_at") else None
        eids_raw = row.get("solution_expert_employee_ids") or "[]"
        try:
            ids = json.loads(eids_raw) if isinstance(eids_raw, str) else list(eids_raw)
        except (ValueError, TypeError):
            ids = []
        row["solution_expert_employee_ids"] = [str(x) for x in ids if x]
        return Conversation(**row)

    def list(self) -> list[Conversation]:
        rows = self._db.query(
            "SELECT id, title, state, COALESCE(collaboration_mode, 'free') AS collaboration_mode, "
            "COALESCE(orchestration_brief, '') AS orchestration_brief, planner_employee_id, entry_employee_id, "
            "last_read_at, last_read_message_id, created_at, updated_at, "
            "solution_instance_id, "
            "COALESCE(solution_planner_prompt, '') AS solution_planner_prompt, "
            "COALESCE(solution_subtask_prompt, '') AS solution_subtask_prompt, "
            "COALESCE(solution_aggregate_prompt, '') AS solution_aggregate_prompt, "
            "COALESCE(solution_expert_employee_ids, '[]') AS solution_expert_employee_ids "
            "FROM conversations ORDER BY created_at, rowid"
        )
        result = []
        for r in rows:
            d = dict(r)
            d["last_read_at"] = datetime.fromisoformat(d["last_read_at"]) if d.get("last_read_at") else None
            eids_raw = d.get("solution_expert_employee_ids") or "[]"
            try:
                ids = json.loads(eids_raw) if isinstance(eids_raw, str) else list(eids_raw)
            except (ValueError, TypeError):
                ids = []
            d["solution_expert_employee_ids"] = [str(x) for x in ids if x]
            result.append(Conversation(**d))
        return result

    def set_state(self, conversation_id: str, state: ConversationState) -> Conversation:
        self.get(conversation_id)  # 存在性校验 -> NotFound
        self._db.execute(
            "UPDATE conversations SET state = ?, updated_at = ? WHERE id = ?",
            (state.value, _iso(_now()), conversation_id),
        )
        return self.get(conversation_id)

    def update_collaboration(
        self,
        conversation_id: str,
        *,
        collaboration_mode: str | None = None,
        orchestration_brief: str | None = None,
        planner_employee_id: str | None | object = None,
        solution_instance_id: str | None | object = None,
        solution_planner_prompt: str | None = None,
        solution_subtask_prompt: str | None = None,
        solution_aggregate_prompt: str | None = None,
    ) -> Conversation:
        """更新群聊协作编排字段（orchestrated 必填 brief；free 清空 brief）。

        方案实例绑定（solution_instance_id）和三阶段 prompts 在会话创建时一次性写入；
        PATCH 路径仅允许清空/同步传入同值（防覆盖），固定编排语义要求 prompts 只读。
        """
        conv = self.get(conversation_id)
        if collaboration_mode is not None:
            conv = Conversation(
                **{**conv.model_dump(), "collaboration_mode": "orchestrated" if str(collaboration_mode) == "orchestrated" else "free"}
            )
        if conv.collaboration_mode == "orchestrated":
            if orchestration_brief is not None:
                conv = Conversation(**{**conv.model_dump(), "orchestration_brief": str(orchestration_brief).strip()})
            if not str(conv.orchestration_brief or "").strip():
                raise ValueError("orchestration_brief is required when collaboration_mode is orchestrated")
        else:
            conv = Conversation(**{**conv.model_dump(), "orchestration_brief": ""})
        if planner_employee_id is not None:
            value = None if (isinstance(planner_employee_id, str) and not planner_employee_id.strip()) else planner_employee_id
            conv = Conversation(**{**conv.model_dump(), "planner_employee_id": value})
        # 方案绑定：仅允许设置（创建时）或同值同步；不允许覆盖为不同值（固定编排）。
        if solution_instance_id is not None:
            value = None if (isinstance(solution_instance_id, str) and not solution_instance_id.strip()) else solution_instance_id
            prev = conv.solution_instance_id
            if prev is not None and value is not None and prev != value:
                raise Conflict(f"solution_instance_id already bound to {prev!r}; cannot rebind to {value!r}")
            conv = Conversation(**{**conv.model_dump(), "solution_instance_id": value})
        if solution_planner_prompt is not None:
            conv = Conversation(**{**conv.model_dump(), "solution_planner_prompt": str(solution_planner_prompt)})
        if solution_subtask_prompt is not None:
            conv = Conversation(**{**conv.model_dump(), "solution_subtask_prompt": str(solution_subtask_prompt)})
        if solution_aggregate_prompt is not None:
            conv = Conversation(**{**conv.model_dump(), "solution_aggregate_prompt": str(solution_aggregate_prompt)})
        if solution_expert_employee_ids is not None:
            ids = solution_expert_employee_ids if isinstance(solution_expert_employee_ids, list) else []
            # 防御：不可变快照语义 —— 已有列表时不允许重建（除非显式传 None 清空）。
            prev_ids = conv.solution_expert_employee_ids
            if prev_ids and ids and prev_ids != ids:
                raise Conflict(
                    f"solution_expert_employee_ids already bound to {prev_ids!r}; cannot rebind"
                )
            conv = Conversation(**{**conv.model_dump(), "solution_expert_employee_ids": [str(x) for x in ids]})
        self._db.execute(
            "UPDATE conversations SET collaboration_mode = ?, orchestration_brief = ?, "
            "planner_employee_id = ?, updated_at = ?, solution_instance_id = ?, "
            "solution_planner_prompt = ?, solution_subtask_prompt = ?, solution_aggregate_prompt = ?, "
            "solution_expert_employee_ids = ? "
            "WHERE id = ?",
            (conv.collaboration_mode, conv.orchestration_brief, conv.planner_employee_id,
             _iso(_now()), conv.solution_instance_id,
             conv.solution_planner_prompt, conv.solution_subtask_prompt, conv.solution_aggregate_prompt,
             json.dumps(conv.solution_expert_employee_ids),
             conversation_id),
        )
        return self.get(conversation_id)

    def update_read_status(
        self,
        conversation_id: str,
        *,
        last_read_at: datetime | None = None,
        last_read_message_id: str | None | object = None,
    ) -> Conversation:
        """更新会话阅读状态（last_read_at / last_read_message_id）；空串 message_id 视为 None 清除。"""
        self.get(conversation_id)  # 存在性校验 -> NotFound
        if last_read_at is not None:
            self._db.execute(
                "UPDATE conversations SET last_read_at = ?, updated_at = ? WHERE id = ?",
                (_iso(last_read_at), _iso(_now()), conversation_id),
            )
        if last_read_message_id is not None:
            value = None if (isinstance(last_read_message_id, str) and not last_read_message_id.strip()) else last_read_message_id
            self._db.execute(
                "UPDATE conversations SET last_read_message_id = ?, updated_at = ? WHERE id = ?",
                (value, _iso(_now()), conversation_id),
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
        data.setdefault("trigger_type", "manual_run")
        data.setdefault("execution_mode", "single_agent")
        # AITEAM-689 (M1)：快照绑定列；旧库无列时 get() 不会返回这些键，用安全默认回填。
        data.setdefault("snapshot_version", None)
        data.setdefault("snapshot_source", "none")
        data.setdefault("employee_id", None)
        data.setdefault("runtime", None)
        data.setdefault("provider_ref", None)
        skill_raw = data.get("skill_refs")
        if skill_raw is None:
            data["skill_refs"] = []
        elif isinstance(skill_raw, str):
            try:
                parsed = json.loads(skill_raw)
                data["skill_refs"] = list(parsed) if isinstance(parsed, list) else []
            except (ValueError, TypeError):
                data["skill_refs"] = []
        return Run(**data)

    def create(self, run: Run) -> Run:
        self._db.execute(
            "INSERT INTO runs (id, conversation_id, status, trigger_type, execution_mode, "
            "session_id, error, usage, created_at, updated_at, "
            "snapshot_version, snapshot_source, employee_id, runtime, provider_ref, skill_refs) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (run.id, run.conversation_id, run.status.value, run.trigger_type.value,
             run.execution_mode.value, run.session_id, run.error,
             json.dumps(run.usage) if run.usage is not None else None,
             _iso(run.created_at), _iso(run.updated_at),
             run.snapshot_version, getattr(run, "snapshot_source", "none"),
             run.employee_id, run.runtime, run.provider_ref,
             json.dumps(run.skill_refs)),
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
                 session_id: str | None, error: str | None, usage: dict | None,
                 trigger_type: RunTriggerType | None = None,
                 execution_mode: RunExecutionMode | None = None) -> Run:
        self.get(run_id)  # 存在性校验 -> NotFound
        self._db.execute(
            "UPDATE runs SET status = ?, trigger_type = COALESCE(?, trigger_type), "
            "execution_mode = COALESCE(?, execution_mode), "
            "session_id = ?, error = ?, usage = ?, updated_at = ? "
            "WHERE id = ?",
            (status.value,
             trigger_type.value if trigger_type is not None else None,
             execution_mode.value if execution_mode is not None else None,
             session_id, error,
             json.dumps(usage) if usage is not None else None, _iso(_now()), run_id),
        )
        return self.get(run_id)

    def update_status(self, run_id: str, run: Run) -> Run:
        self.get(run_id)  # 存在性校验 -> NotFound
        self._db.execute(
            "UPDATE runs SET status = ?, trigger_type = ?, execution_mode = ?, updated_at = ? "
            "WHERE id = ?",
            (run.status.value, run.trigger_type.value, run.execution_mode.value,
             _iso(_now()), run_id),
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
