"""单 run token 级计量明细（A5 审计回流，#293）。

与脱敏 outbox（存聚合后的 UsageSummary）互补：本模块存每个 run 的 input/output token、cost、
error、duration 明细，供按 employee_id / run_id 精确对账——outbox 的 hourly 聚合做不到这一点。

字段口径对齐旧版 ``app/team_panel/repositories/usage_ledger_repo.py``（tenant 语义下 tenant_id 替代
enterprise_id；cost 以整数分存储，禁 float 累加误差，02 §10.3.5）。幂等键 (run_id, source_type)。
"""

from __future__ import annotations

import json
import uuid
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from ..local_db import LocalDb


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


class UsageLedger(BaseModel):
    """单 run token 级计量明细。

    ``total_tokens`` 优先由调用方传入；缺省时按 input+output 求和（与聚合器归一一致）。
    ``cost_cents`` 以整数分存（禁 float）。
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    tenant_id: str
    employee_id: str | None = None
    run_id: str
    conversation_id: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cost_cents: int = 0
    error: bool = False
    duration_seconds: int = 0
    source_type: str = "run_summary"  # run_summary | usage_event | backfill
    occurred_at: datetime = Field(default_factory=_now)
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)
    deleted_at: datetime | None = None

    def normalized_total(self) -> int:
        if self.total_tokens > 0:
            return self.total_tokens
        return (self.input_tokens or 0) + (self.output_tokens or 0)


def _coerce_bool_int(value: bool | int) -> int:
    return 1 if value else 0


def _to_cents(value: Decimal | float | int | str | None) -> int:
    if value is None:
        return 0
    try:
        return int(Decimal(str(value)) * Decimal("100"))
    except Exception:  # noqa: BLE001 — 非数值成本视作 0 分，不中断对账链路。
        return 0


def _row_to_ledger(row) -> UsageLedger:
    data = dict(row)
    return UsageLedger(
        id=data["id"],
        tenant_id=data["tenant_id"],
        employee_id=data["employee_id"] or None,
        run_id=data["run_id"],
        conversation_id=data["conversation_id"] or None,
        input_tokens=data["input_tokens"],
        output_tokens=data["output_tokens"],
        total_tokens=data["total_tokens"],
        cost_cents=data["cost_cents"],
        error=bool(data["error"]),
        duration_seconds=data["duration_seconds"],
        source_type=data["source_type"],
        occurred_at=datetime.fromisoformat(data["occurred_at"]),
        created_at=datetime.fromisoformat(data["created_at"]),
        updated_at=datetime.fromisoformat(data["updated_at"]),
        deleted_at=datetime.fromisoformat(data["deleted_at"]) if data["deleted_at"] else None,
    )


class UsageLedgerRepository(ABC):
    @abstractmethod
    def upsert(self, item: UsageLedger) -> UsageLedger:
        """按 (run_id, source_type) 幂等写入：同 key 反复写入只更新不重复。已 deleted 视作新行。"""

    @abstractmethod
    def get(self, run_id: str, source_type: str) -> UsageLedger | None:
        """按 (run_id, source_type) 取单条明细；deleted 的不返回。"""

    @abstractmethod
    def list_by_employee(self, employee_id: str) -> list[UsageLedger]:
        """按 employee 列所有未 deleted 明细，按 occurred_at 升序。"""

    @abstractmethod
    def aggregate_by_employee(self) -> dict[str, dict]:
        """按 employee_id 分组统计：run_count / token_total / cost_cents_total / error_count。"""


class InMemoryUsageLedgerRepository(UsageLedgerRepository):
    def __init__(self) -> None:
        self._items: dict[tuple[str, str], UsageLedger] = {}

    def upsert(self, item: UsageLedger) -> UsageLedger:
        key = (item.run_id, item.source_type)
        existing = self._items.get(key)
        if existing is not None and existing.deleted_at is None:
            updated = existing.model_copy(
                update={
                    "tenant_id": item.tenant_id,
                    "employee_id": item.employee_id,
                    "conversation_id": item.conversation_id,
                    "input_tokens": item.input_tokens,
                    "output_tokens": item.output_tokens,
                    "total_tokens": item.total_tokens,
                    "cost_cents": item.cost_cents,
                    "error": item.error,
                    "duration_seconds": item.duration_seconds,
                    "occurred_at": item.occurred_at,
                    "updated_at": _now(),
                }
            )
            self._items[key] = updated
            return updated
        new = item.model_copy(update={"created_at": _now(), "updated_at": _now()})
        self._items[key] = new
        return new

    def get(self, run_id: str, source_type: str) -> UsageLedger | None:
        item = self._items.get((run_id, source_type))
        if item is None or item.deleted_at is not None:
            return None
        return item

    def list_by_employee(self, employee_id: str) -> list[UsageLedger]:
        rows = [i for i in self._items.values() if i.employee_id == employee_id and i.deleted_at is None]
        return sorted(rows, key=lambda i: i.occurred_at)

    def aggregate_by_employee(self) -> dict[str, dict]:
        buckets: dict[str, dict] = {}
        for i in self._items.values():
            if i.deleted_at is not None:
                continue
            emp = i.employee_id or ""
            b = buckets.setdefault(
                emp,
                {"employee_id": emp, "run_count": 0, "token_total": 0,
                 "cost_cents_total": 0, "error_count": 0},
            )
            b["run_count"] += 1
            b["token_total"] += i.normalized_total()
            b["cost_cents_total"] += i.cost_cents
            b["error_count"] += 1 if i.error else 0
        return dict(sorted(buckets.items()))


class SqliteUsageLedgerRepository(UsageLedgerRepository):
    def __init__(self, db: LocalDb) -> None:
        self._db = db

    def _insert(self, item: UsageLedger) -> None:
        self._db.execute(
            "INSERT INTO usage_ledger (id, tenant_id, employee_id, run_id, conversation_id, "
            "input_tokens, output_tokens, total_tokens, cost_cents, error, duration_seconds, "
            "source_type, occurred_at, created_at, updated_at, deleted_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (item.id, item.tenant_id, item.employee_id, item.run_id, item.conversation_id,
             item.input_tokens, item.output_tokens, item.total_tokens, item.cost_cents,
             _coerce_bool_int(item.error), item.duration_seconds, item.source_type,
             _iso(item.occurred_at), _iso(item.created_at), _iso(item.updated_at),
             _iso(item.deleted_at) if item.deleted_at else None),
        )

    def upsert(self, item: UsageLedger) -> UsageLedger:
        existing_row = self._db.query_one(
            "SELECT * FROM usage_ledger WHERE run_id = ? AND source_type = ? AND deleted_at IS NULL",
            (item.run_id, item.source_type),
        )
        now = _now()
        if existing_row is not None:
            self._db.execute(
                "UPDATE usage_ledger SET tenant_id = ?, employee_id = ?, conversation_id = ?, "
                "input_tokens = ?, output_tokens = ?, total_tokens = ?, cost_cents = ?, error = ?, "
                "duration_seconds = ?, occurred_at = ?, updated_at = ? "
                "WHERE run_id = ? AND source_type = ? AND deleted_at IS NULL",
                (item.tenant_id, item.employee_id, item.conversation_id,
                 item.input_tokens, item.output_tokens, item.total_tokens, item.cost_cents,
                 _coerce_bool_int(item.error), item.duration_seconds, _iso(item.occurred_at),
                 _iso(now), item.run_id, item.source_type),
            )
            row = self._db.query_one(
                "SELECT * FROM usage_ledger WHERE run_id = ? AND source_type = ?",
                (item.run_id, item.source_type),
            )
            return _row_to_ledger(row)
        created = item.model_copy(update={"created_at": now, "updated_at": now})
        self._insert(created)
        return created

    def get(self, run_id: str, source_type: str) -> UsageLedger | None:
        row = self._db.query_one(
            "SELECT * FROM usage_ledger WHERE run_id = ? AND source_type = ? AND deleted_at IS NULL",
            (run_id, source_type),
        )
        return _row_to_ledger(row) if row else None

    def list_by_employee(self, employee_id: str) -> list[UsageLedger]:
        rows = self._db.query(
            "SELECT * FROM usage_ledger WHERE employee_id = ? AND deleted_at IS NULL "
            "ORDER BY occurred_at ASC, rowid",
            (employee_id,),
        )
        return [_row_to_ledger(r) for r in rows]

    def aggregate_by_employee(self) -> dict[str, dict]:
        rows = self._db.query(
            "SELECT employee_id, COUNT(*) AS run_count, "
            "SUM(total_tokens) AS token_total, SUM(cost_cents) AS cost_cents_total, "
            "SUM(error) AS error_count "
            "FROM usage_ledger WHERE deleted_at IS NULL GROUP BY employee_id "
            "ORDER BY employee_id",
        )
        return {
            (r["employee_id"] or ""): {
                "employee_id": r["employee_id"] or "",
                "run_count": r["run_count"],
                "token_total": r["token_total"] or 0,
                "cost_cents_total": r["cost_cents_total"] or 0,
                "error_count": r["error_count"] or 0,
            }
            for r in rows
        }
