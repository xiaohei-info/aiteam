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
    def list_enabled(self) -> list[Loop]: ...
    @abstractmethod
    def set_status(self, loop_id: str, status: LoopStatus) -> Loop: ...
    @abstractmethod
    def record_fire(self, loop_id: str, *, run_id: str) -> Loop:
        """记一次触发：fire_count+1、last_run_id、last_fired_at。"""


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

    def list_enabled(self) -> list[Loop]:
        return [l for l in self.list() if l.status is LoopStatus.ENABLED]

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


# ---- SQLite 实现（agent 本地库；与内存实现行为等价，重启不丢）----

def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt is not None else None


class SqliteLoopRepository(LoopRepository):
    """SQLite loop 仓储（本地库持久化，#159）。"""

    def __init__(self, db: LocalDb) -> None:
        self._db = db

    @staticmethod
    def _row_to_loop(row) -> Loop:
        data = dict(row)
        data["run_spec"] = json.loads(data["run_spec"])
        return Loop(**data)

    def create(self, loop: Loop) -> Loop:
        self._db.execute(
            "INSERT INTO loops (id, conversation_id, cron, run_spec, title, status, "
            "fire_count, last_run_id, last_fired_at, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (loop.id, loop.conversation_id, loop.cron, json.dumps(loop.run_spec.model_dump()),
             loop.title, loop.status.value, loop.fire_count, loop.last_run_id,
             _iso(loop.last_fired_at), _iso(loop.created_at), _iso(loop.updated_at)),
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

    def list_enabled(self) -> list[Loop]:
        rows = self._db.query(
            "SELECT * FROM loops WHERE status = ? ORDER BY created_at, rowid",
            (LoopStatus.ENABLED.value,),
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
