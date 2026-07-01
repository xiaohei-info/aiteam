"""Loop 本地调度仓储（A3）。

接口 + 内存实现。**agent 本地库**（与 mainline 同口径）：用户端单租户本地库，无 tenant
路由。真实持久化（SQLite/本地 PG）后续替换实现，接口形状不变。

只读不存在的 loop 抛 shared.errors.NotFound（统一 problem+json）。
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from datetime import datetime, timezone

from shared.errors import NotFound

from ..local_db import LocalDb
from .models import Loop, LoopStatus


def _now() -> datetime:
    return datetime.now(timezone.utc)


class LoopRepository(ABC):
    @abstractmethod
    def create(self, loop: Loop) -> Loop: ...
    @abstractmethod
    def get(self, loop_id: str) -> Loop: ...
    @abstractmethod
    def list(self) -> list[Loop]: ...
    @abstractmethod
    def list_active(self) -> list[Loop]: ...
    @abstractmethod
    def set_status(self, loop_id: str, status: LoopStatus) -> Loop: ...
    @abstractmethod
    def record_fire(self, loop_id: str, *, run_id: str) -> Loop:
        """记一次触发：fire_count+1、last_run_id、last_fired_at。"""

    @abstractmethod
    def record_failure(self, loop_id: str) -> Loop:
        """记一次失败：retry_count+1；达 max_retries 且 active 时自迁至 error。"""

    @abstractmethod
    def record_success(self, loop_id: str) -> Loop:
        """记一次成功：重置 retry_count。"""

    @abstractmethod
    def update(self, loop: Loop) -> Loop:
        """持久化 loop 全字段（含 recurrence/retry 等）。"""


class InMemoryLoopRepository(LoopRepository):
    """内存 loop 仓储（本地库占位；接口稳定，真实持久化后续替换）。"""

    def __init__(self) -> None:
        self._items: dict[str, Loop] = {}

    def create(self, loop: Loop) -> Loop:
        self._items[loop.id] = loop
        return loop

    def get(self, loop_id: str) -> Loop:
        item = self._items.get(loop_id)
        if item is None:
            raise NotFound(f"loop {loop_id} not found")
        return item

    def list(self) -> list[Loop]:
        return sorted(self._items.values(), key=lambda l: l.created_at)

    def list_active(self) -> list[Loop]:
        return [l for l in self.list() if l.status is LoopStatus.ACTIVE]

    def set_status(self, loop_id: str, status: LoopStatus) -> Loop:
        item = self.get(loop_id)
        updated = item.model_copy(update={"status": status, "updated_at": _now()})
        self._items[loop_id] = updated
        return updated

    def record_fire(self, loop_id: str, *, run_id: str) -> Loop:
        item = self.get(loop_id)
        updated = item.model_copy(update={
            "fire_count": item.fire_count + 1,
            "last_run_id": run_id,
            "last_fired_at": _now(),
            "updated_at": _now(),
        })
        self._items[loop_id] = updated
        return updated

    def record_failure(self, loop_id: str) -> Loop:
        item = self.get(loop_id)
        item.record_failure()
        item.updated_at = _now()
        self._items[loop_id] = item
        return item

    def record_success(self, loop_id: str) -> Loop:
        item = self.get(loop_id)
        item.record_success()
        item.updated_at = _now()
        self._items[loop_id] = item
        return item

    def update(self, loop: Loop) -> Loop:
        loop.updated_at = _now()
        self._items[loop.id] = loop
        return loop


# ---- SQLite 实现（agent 本地库；与内存实现行为等价，重启不丢）----

def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt is not None else None


_COLUMNS = (
    "id, conversation_id, cron, run_spec, title, recurrence_type, "
    "recurrence_config, input_template, status, max_retries, retry_count, "
    "fire_count, last_run_id, last_fired_at, created_at, updated_at"
)


class SqliteLoopRepository(LoopRepository):
    """SQLite loop 仓储（本地库持久化，#159）。"""

    def __init__(self, db: LocalDb) -> None:
        self._db = db

    @staticmethod
    def _row_to_loop(row) -> Loop:
        data = dict(row)
        data["run_spec"] = json.loads(data["run_spec"])
        data["recurrence_config"] = (
            json.loads(data["recurrence_config"])
            if data.get("recurrence_config")
            else None
        )
        return Loop(**data)

    def create(self, loop: Loop) -> Loop:
        self._db.execute(
            "INSERT INTO loops ("
            "id, conversation_id, cron, run_spec, title, recurrence_type, "
            "recurrence_config, input_template, status, max_retries, retry_count, "
            "fire_count, last_run_id, last_fired_at, created_at, updated_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (loop.id, loop.conversation_id, loop.cron, json.dumps(loop.run_spec.model_dump()),
             loop.title, loop.recurrence_type.value,
             json.dumps(loop.recurrence_config) if loop.recurrence_config is not None else None,
             loop.input_template, loop.status.value, loop.max_retries, loop.retry_count,
             loop.fire_count, loop.last_run_id, _iso(loop.last_fired_at),
             _iso(loop.created_at), _iso(loop.updated_at)),
        )
        return loop

    def get(self, loop_id: str) -> Loop:
        row = self._db.query_one("SELECT * FROM loops WHERE id = ?", (loop_id,))
        if row is None:
            raise NotFound(f"loop {loop_id} not found")
        return self._row_to_loop(row)

    def list(self) -> list[Loop]:
        rows = self._db.query("SELECT * FROM loops ORDER BY created_at, rowid")
        return [self._row_to_loop(r) for r in rows]

    def list_active(self) -> list[Loop]:
        rows = self._db.query(
            "SELECT * FROM loops WHERE status = ? ORDER BY created_at, rowid",
            (LoopStatus.ACTIVE.value,),
        )
        return [self._row_to_loop(r) for r in rows]

    def set_status(self, loop_id: str, status: LoopStatus) -> Loop:
        self.get(loop_id)  # 存在性校验 -> NotFound
        self._db.execute(
            "UPDATE loops SET status = ?, updated_at = ? WHERE id = ?",
            (status.value, _iso(_now()), loop_id),
        )
        return self.get(loop_id)

    def record_fire(self, loop_id: str, *, run_id: str) -> Loop:
        item = self.get(loop_id)
        now = _now()
        self._db.execute(
            "UPDATE loops SET fire_count = ?, last_run_id = ?, last_fired_at = ?, updated_at = ? "
            "WHERE id = ?",
            (item.fire_count + 1, run_id, _iso(now), _iso(now), loop_id),
        )
        return self.get(loop_id)

    def record_failure(self, loop_id: str) -> Loop:
        item = self.get(loop_id)
        item.record_failure()
        self._db.execute(
            "UPDATE loops SET retry_count = ?, status = ?, updated_at = ? WHERE id = ?",
            (item.retry_count, item.status.value, _iso(_now()), loop_id),
        )
        return self.get(loop_id)

    def record_success(self, loop_id: str) -> Loop:
        item = self.get(loop_id)
        item.record_success()
        self._db.execute(
            "UPDATE loops SET retry_count = ?, updated_at = ? WHERE id = ?",
            (item.retry_count, _iso(_now()), loop_id),
        )
        return self.get(loop_id)

    def update(self, loop: Loop) -> Loop:
        self.get(loop.id)
        self._db.execute(
            "UPDATE loops SET "
            "conversation_id=?, cron=?, run_spec=?, title=?, recurrence_type=?, "
            "recurrence_config=?, input_template=?, status=?, max_retries=?, retry_count=?, "
            "fire_count=?, last_run_id=?, last_fired_at=?, updated_at=? WHERE id=?",
            (loop.conversation_id, loop.cron, json.dumps(loop.run_spec.model_dump()),
             loop.title, loop.recurrence_type.value,
             json.dumps(loop.recurrence_config) if loop.recurrence_config is not None else None,
             loop.input_template, loop.status.value, loop.max_retries, loop.retry_count,
             loop.fire_count, loop.last_run_id, _iso(loop.last_fired_at),
             _iso(_now()), loop.id),
        )
        return self.get(loop.id)
