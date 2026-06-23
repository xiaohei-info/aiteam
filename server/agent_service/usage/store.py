"""脱敏摘要 outbox 仓储（A5，04 §6.5 可靠性 / 05 §5.1）。

outbox 模式：脱敏摘要先落本地待发队列（pending），上报成功后置 sent。
- **幂等**：以 summary_id 为主键；同一 summary 反复 enqueue 不产生重复条目（已存在则更新内容、
  保留状态）。已 sent 的不回退 pending（不重复上报）。
- **不丢**：pending 持久于本地库直至 sent；上报失败留 pending 等下次 drain。
- **可重试**：记录 attempts/last_error 供观测与退避。

agent 本地库口径（与 loop/mainline 一致）：用户端单租户本地库；但 outbox 条目仍带 tenant_id
（摘要 payload 的一部分，上报需要）。接口 + 内存实现，真实持久化后续替换不改形状。
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.summary import AuditSummaryEvent, UsageSummary

from ..local_db import LocalDb


def _now() -> datetime:
    return datetime.now(timezone.utc)


class OutboxStatus(str, Enum):
    PENDING = "pending"
    SENT = "sent"


class OutboxKind(str, Enum):
    USAGE = "usage"
    AUDIT = "audit"


class OutboxItem(BaseModel):
    """一条待发脱敏摘要。payload 是契约摘要（已脱敏），绝不含会话内容。"""

    model_config = ConfigDict(extra="forbid")

    summary_id: str = Field(description="幂等键 = 摘要 summary_id")
    tenant_id: str
    kind: OutboxKind
    usage: UsageSummary | None = None
    audit: AuditSummaryEvent | None = None
    status: OutboxStatus = OutboxStatus.PENDING
    attempts: int = 0
    last_error: str | None = None
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class OutboxRepository(ABC):
    @abstractmethod
    def upsert(self, item: OutboxItem) -> OutboxItem:
        """按 summary_id 幂等写入：新建或更新内容；已 sent 的不回退、不重复入队。"""

    @abstractmethod
    def list_pending(self, tenant_id: str | None = None) -> list[OutboxItem]: ...

    @abstractmethod
    def list_all(self) -> list[OutboxItem]: ...

    @abstractmethod
    def mark_sent(self, summary_id: str) -> OutboxItem: ...

    @abstractmethod
    def mark_failed(self, summary_id: str, error: str) -> OutboxItem: ...


class InMemoryOutboxRepository(OutboxRepository):
    """内存 outbox（本地库占位；接口稳定，真实持久化后续替换）。"""

    def __init__(self) -> None:
        self._items: dict[str, OutboxItem] = {}

    def upsert(self, item: OutboxItem) -> OutboxItem:
        existing = self._items.get(item.summary_id)
        if existing is not None and existing.status is OutboxStatus.SENT:
            # 已上报：幂等——不回退状态、不重复入队，保留既有条目。
            return existing
        if existing is not None:
            updated = existing.model_copy(
                update={
                    "kind": item.kind,
                    "usage": item.usage,
                    "audit": item.audit,
                    "tenant_id": item.tenant_id,
                    "updated_at": _now(),
                }
            )
            self._items[item.summary_id] = updated
            return updated
        self._items[item.summary_id] = item
        return item

    def list_pending(self, tenant_id: str | None = None) -> list[OutboxItem]:
        items = [i for i in self._items.values() if i.status is OutboxStatus.PENDING]
        if tenant_id is not None:
            items = [i for i in items if i.tenant_id == tenant_id]
        return sorted(items, key=lambda i: i.created_at)

    def list_all(self) -> list[OutboxItem]:
        return sorted(self._items.values(), key=lambda i: i.created_at)

    def mark_sent(self, summary_id: str) -> OutboxItem:
        item = self._items[summary_id]
        updated = item.model_copy(
            update={"status": OutboxStatus.SENT, "last_error": None, "updated_at": _now()}
        )
        self._items[summary_id] = updated
        return updated

    def mark_failed(self, summary_id: str, error: str) -> OutboxItem:
        item = self._items[summary_id]
        updated = item.model_copy(
            update={
                "attempts": item.attempts + 1,
                "last_error": error,
                "updated_at": _now(),
            }
        )
        self._items[summary_id] = updated
        return updated


# ---- SQLite 实现（agent 本地库；与内存实现行为等价，重启不丢）----

def _iso(dt: datetime) -> str:
    return dt.isoformat()


class SqliteOutboxRepository(OutboxRepository):
    """SQLite outbox 仓储（本地库持久化，#159）。"""

    def __init__(self, db: LocalDb) -> None:
        self._db = db

    @staticmethod
    def _row_to_item(row) -> OutboxItem:
        data = dict(row)
        data["usage"] = UsageSummary(**json.loads(data["usage"])) if data["usage"] else None
        data["audit"] = AuditSummaryEvent(**json.loads(data["audit"])) if data["audit"] else None
        return OutboxItem(**data)

    def upsert(self, item: OutboxItem) -> OutboxItem:
        existing_row = self._db.query_one(
            "SELECT * FROM outbox_items WHERE summary_id = ?", (item.summary_id,)
        )
        if existing_row is not None:
            existing = self._row_to_item(existing_row)
            if existing.status is OutboxStatus.SENT:
                # 已上报：幂等——不回退状态、不重复入队，保留既有条目。
                return existing
            # 更新既有条目内容
            self._db.execute(
                "UPDATE outbox_items SET kind = ?, usage = ?, audit = ?, tenant_id = ?, "
                "updated_at = ? WHERE summary_id = ?",
                (item.kind.value,
                 json.dumps(item.usage.model_dump(mode='json')) if item.usage else None,
                 json.dumps(item.audit.model_dump(mode='json')) if item.audit else None,
                 item.tenant_id, _iso(_now()), item.summary_id),
            )
            return self._row_to_item(
                self._db.query_one("SELECT * FROM outbox_items WHERE summary_id = ?",
                                   (item.summary_id,))
            )
        # 新建条目
        self._db.execute(
            "INSERT INTO outbox_items (summary_id, tenant_id, kind, usage, audit, status, "
            "attempts, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (item.summary_id, item.tenant_id, item.kind.value,
             json.dumps(item.usage.model_dump(mode='json')) if item.usage else None,
             json.dumps(item.audit.model_dump(mode='json')) if item.audit else None,
             item.status.value, item.attempts, item.last_error,
             _iso(item.created_at), _iso(item.updated_at)),
        )
        return item

    def list_pending(self, tenant_id: str | None = None) -> list[OutboxItem]:
        if tenant_id is not None:
            rows = self._db.query(
                "SELECT * FROM outbox_items WHERE status = ? AND tenant_id = ? "
                "ORDER BY created_at, rowid",
                (OutboxStatus.PENDING.value, tenant_id),
            )
        else:
            rows = self._db.query(
                "SELECT * FROM outbox_items WHERE status = ? ORDER BY created_at, rowid",
                (OutboxStatus.PENDING.value,),
            )
        return [self._row_to_item(r) for r in rows]

    def list_all(self) -> list[OutboxItem]:
        rows = self._db.query("SELECT * FROM outbox_items ORDER BY created_at, rowid")
        return [self._row_to_item(r) for r in rows]

    def mark_sent(self, summary_id: str) -> OutboxItem:
        self._db.execute(
            "UPDATE outbox_items SET status = ?, last_error = NULL, updated_at = ? "
            "WHERE summary_id = ?",
            (OutboxStatus.SENT.value, _iso(_now()), summary_id),
        )
        row = self._db.query_one("SELECT * FROM outbox_items WHERE summary_id = ?", (summary_id,))
        return self._row_to_item(row)

    def mark_failed(self, summary_id: str, error: str) -> OutboxItem:
        # 原子读-改-写：先读取当前 attempts，然后加 1
        row = self._db.query_one(
            "SELECT attempts FROM outbox_items WHERE summary_id = ?", (summary_id,)
        )
        current_attempts = row["attempts"] if row else 0
        self._db.execute(
            "UPDATE outbox_items SET attempts = ?, last_error = ?, updated_at = ? "
            "WHERE summary_id = ?",
            (current_attempts + 1, error, _iso(_now()), summary_id),
        )
        row = self._db.query_one("SELECT * FROM outbox_items WHERE summary_id = ?", (summary_id,))
        return self._row_to_item(row)
