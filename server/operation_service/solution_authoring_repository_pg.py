"""行业文档生成仓储的 PostgreSQL 后端（oper 库，app_rw 连接）。

只实现行的读写；业务规则在 `SolutionAuthoringRepository` 基类。锁顺序固定为「草稿 → 任务」，
领取任务只锁任务行（SKIP LOCKED），因此不会与提交 / 失败 / 续租互相死锁。

全部 SQL 在模块导入时由下面的常量（表名、行类型的字段名、固定的条件子句）一次性生成，
运行时只传参数值，没有任何来自请求的内容进入语句文本。
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import fields
from datetime import datetime
from typing import Any, LiteralString, TypeVar
from uuid import UUID

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Json

from .solution_authoring_repository import (
    DraftRow,
    EventRow,
    FindingRow,
    JobRow,
    SolutionAuthoringRepository,
    SourceRow,
    _Tx,
)

Row = TypeVar("Row", DraftRow, SourceRow, JobRow, FindingRow, EventRow)

_TABLES: dict[type, tuple[LiteralString, LiteralString]] = {
    DraftRow: ("solution_draft", "draft_id"),
    SourceRow: ("solution_source_document", "source_id"),
    JobRow: ("solution_generation_job", "job_id"),
    FindingRow: ("solution_sensitive_finding", "finding_id"),
    EventRow: ("solution_review_event", "event_id"),
}
_JSON_COLUMNS = frozenset({"package", "evidence_sources", "warnings", "usage", "publish_state"})


def _columns(cls: type) -> list[str]:
    return [item.name for item in fields(cls)]


def _select(cls: type, where: LiteralString) -> sql.Composed:
    return sql.SQL("SELECT {} FROM {} WHERE {}").format(
        sql.SQL(", ").join(map(sql.Identifier, _columns(cls))), sql.Identifier(_TABLES[cls][0]), sql.SQL(where),
    )


def _insert(cls: type) -> sql.Composed:
    names = _columns(cls)
    return sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
        sql.Identifier(_TABLES[cls][0]),
        sql.SQL(", ").join(map(sql.Identifier, names)),
        sql.SQL(", ").join(sql.Placeholder(name) for name in names),
    )


def _upsert(cls: type) -> sql.Composed:
    key = _TABLES[cls][1]
    assignments = sql.SQL(", ").join(
        sql.SQL("{} = EXCLUDED.{}").format(sql.Identifier(name), sql.Identifier(name)) for name in _columns(cls) if name != key
    )
    return sql.SQL("{} ON CONFLICT ({}) DO UPDATE SET {}").format(_insert(cls), sql.Identifier(key), assignments)


_DRAFT = _select(DraftRow, "draft_id = %s")
_DRAFT_FOR_UPDATE = _select(DraftRow, "draft_id = %s FOR UPDATE")
_DRAFTS = _select(DraftRow, "TRUE")
_SOURCES = _select(SourceRow, "draft_id = %s")
_JOBS = _select(JobRow, "draft_id = %s")
_JOB = _select(JobRow, "job_id = %s")
_JOB_FOR_UPDATE = _select(JobRow, "job_id = %s FOR UPDATE")
_JOB_CLAIMABLE = _select(
    JobRow,
    "status = 'queued' OR (status IN ('parsing', 'analyzing') AND lease_expires_at < %s) "
    "ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
)
_FINDINGS = _select(FindingRow, "draft_id = %s")
_EVENTS = _select(EventRow, "draft_id = %s")
_UPSERT = {cls: _upsert(cls) for cls in (DraftRow, SourceRow, JobRow, FindingRow)}
# 审计表只追加（app_rw 没有 UPDATE 权限）。
_INSERT_EVENT = _insert(EventRow)
_DELETE_SOURCE = sql.SQL("DELETE FROM solution_source_document WHERE source_id = %s")
_DELETE_FINDINGS = sql.SQL("DELETE FROM solution_sensitive_finding WHERE draft_id = %s")


def _values(row: Any) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for name in _columns(type(row)):
        value = getattr(row, name)
        values[name] = Json(value) if name in _JSON_COLUMNS and value is not None else value
    return values


class _PgTx(_Tx):
    def __init__(self, conn: psycopg.Connection[Any]):
        self._conn = conn

    def _fetch(self, cls: type[Row], statement: sql.Composed, params: Sequence[Any] = ()) -> list[Row]:
        with self._conn.cursor(row_factory=dict_row) as cursor:
            records = cursor.execute(statement, params).fetchall()
        rows: list[Row] = []
        for record in records:
            data: dict[str, Any] = {key: str(value) if isinstance(value, UUID) else value for key, value in record.items()}
            rows.append(cls(**data))
        return rows

    def _first(self, cls: type[Row], statement: sql.Composed, params: Sequence[Any]) -> Row | None:
        rows = self._fetch(cls, statement, params)
        return rows[0] if rows else None

    def _write(self, statement: sql.SQL | sql.Composed, params: Sequence[Any] | dict[str, Any]) -> None:
        with self._conn.cursor() as cursor:
            cursor.execute(statement, params)

    def draft(self, draft_id: str, *, lock: bool = False) -> DraftRow | None:
        return self._first(DraftRow, _DRAFT_FOR_UPDATE if lock else _DRAFT, (draft_id,))

    def drafts(self) -> list[DraftRow]:
        return self._fetch(DraftRow, _DRAFTS)

    def put_draft(self, row: DraftRow) -> None:
        self._write(_UPSERT[DraftRow], _values(row))

    def sources(self, draft_id: str) -> list[SourceRow]:
        return self._fetch(SourceRow, _SOURCES, (draft_id,))

    def put_source(self, row: SourceRow) -> None:
        self._write(_UPSERT[SourceRow], _values(row))

    def delete_source(self, source_id: str) -> None:
        self._write(_DELETE_SOURCE, (source_id,))

    def jobs(self, draft_id: str) -> list[JobRow]:
        return self._fetch(JobRow, _JOBS, (draft_id,))

    def job(self, job_id: str, *, lock: bool = False) -> JobRow | None:
        return self._first(JobRow, _JOB_FOR_UPDATE if lock else _JOB, (job_id,))

    def next_claimable_job(self, now: datetime) -> JobRow | None:
        return self._first(JobRow, _JOB_CLAIMABLE, (now,))

    def put_job(self, row: JobRow) -> None:
        self._write(_UPSERT[JobRow], _values(row))

    def findings(self, draft_id: str) -> list[FindingRow]:
        return self._fetch(FindingRow, _FINDINGS, (draft_id,))

    def put_finding(self, row: FindingRow) -> None:
        self._write(_UPSERT[FindingRow], _values(row))

    def delete_findings(self, draft_id: str) -> None:
        self._write(_DELETE_FINDINGS, (draft_id,))

    def events(self, draft_id: str) -> list[EventRow]:
        return self._fetch(EventRow, _EVENTS, (draft_id,))

    def add_event(self, row: EventRow) -> None:
        self._write(_INSERT_EVENT, _values(row))


class PgSolutionAuthoringRepository(SolutionAuthoringRepository):
    def __init__(self, dsn: str, clock: Callable[[], datetime] | None = None):
        super().__init__(clock)
        self._dsn = dsn

    @contextmanager
    def _transaction(self) -> Iterator[_Tx]:
        # 连接的上下文管理器：正常退出提交，异常回滚。
        with psycopg.connect(self._dsn) as conn:
            yield _PgTx(conn)
