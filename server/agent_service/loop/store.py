"""Loop 本地调度仓储（A3）。

接口 + 内存实现。**agent 本地库**（与 mainline 同口径）：用户端单租户本地库，无 tenant
路由。真实持久化（SQLite/本地 PG）后续替换实现，接口形状不变。

只读不存在的 loop 抛 shared.errors.NotFound（统一 problem+json）。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timezone

from shared.errors import NotFound

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
