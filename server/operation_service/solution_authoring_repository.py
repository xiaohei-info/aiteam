"""行业文档生成：运营端仓储（oper 库，单写者 = Operator）。

所有会改动草稿的操作都走同一种形态：一个事务里锁住草稿 → 判断 → 写草稿 / 发现项 / 任务 / 审计事件。
这些规则（幂等、状态闸门、乐观版本、任务租约）只写一遍，放在基类里；内存与 PostgreSQL 两个后端只实现
「行的读写」（`_Tx`），因此内存实现上的测试覆盖的就是生产路径的规则。
"""

from __future__ import annotations

import threading
import uuid
from abc import ABC, abstractmethod
from collections.abc import Callable, Collection, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any

from shared.errors import Conflict, InvalidTransition, NotFound, RequestTooLarge, ValidationProblem

ACTIVE_JOB_STATUSES = frozenset({"queued", "parsing", "analyzing"})


@dataclass(frozen=True)
class DraftRow:
    draft_id: str
    title: str
    model_provider_id: str
    model_id: str
    created_by: str
    updated_by: str
    created_at: datetime
    updated_at: datetime
    status: str = "draft"
    image_recognition: str = "none"
    supplement: str = ""
    package: dict[str, Any] | None = None
    evidence_sources: dict[str, Any] = field(default_factory=dict)
    warnings: list[Any] = field(default_factory=list)
    prompt_version: str = ""
    usage: dict[str, Any] = field(default_factory=dict)
    review_note: str = ""
    publish_state: dict[str, Any] = field(default_factory=dict)
    published_solution_id: str | None = None
    version: int = 1


@dataclass(frozen=True)
class SourceRow:
    source_id: str
    draft_id: str
    file_name: str
    size_bytes: int
    sha256: str
    storage_key: str
    created_by: str
    created_at: datetime
    seq: int = 0
    status: str = "uploaded"
    error_code: str | None = None
    chunk_count: int = 0
    image_count: int = 0
    warnings: list[Any] = field(default_factory=list)


@dataclass(frozen=True)
class JobRow:
    job_id: str
    draft_id: str
    created_by: str
    created_at: datetime
    status: str = "queued"
    idempotency_key: str | None = None
    attempt: int = 0
    lease_owner: str | None = None
    lease_expires_at: datetime | None = None
    error_code: str | None = None
    error_message: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)
    started_at: datetime | None = None
    finished_at: datetime | None = None


@dataclass(frozen=True)
class FindingRow:
    finding_id: str
    draft_id: str
    kind: str
    origin: str
    created_at: datetime
    field_path: str = ""
    excerpt: str = ""
    masked: str = ""
    chunk_id: str = ""
    locator: str = ""
    note: str = ""
    status: str = "open"
    resolved_by: str | None = None
    resolved_at: datetime | None = None


@dataclass(frozen=True)
class EventRow:
    event_id: str
    draft_id: str
    action: str
    actor_id: str
    created_at: datetime
    summary: str = ""


@dataclass
class DraftChange:
    """一次草稿变更：草稿字段、发现项的增改、一条审计事件。整体在一个事务里生效。"""

    changes: dict[str, Any] = field(default_factory=dict)
    finding_updates: dict[str, dict[str, Any]] = field(default_factory=dict)
    new_findings: list[FindingRow] = field(default_factory=list)
    replace_findings: bool = False
    event: tuple[str, str] | None = None  # (action, summary)；summary 不得含草稿或文档正文


Decide = Callable[[DraftRow, list[FindingRow]], DraftChange]


class _Tx(ABC):
    """事务内的行读写。不含任何业务判断。"""

    @abstractmethod
    def draft(self, draft_id: str, *, lock: bool = False) -> DraftRow | None: ...
    @abstractmethod
    def drafts(self) -> list[DraftRow]: ...
    @abstractmethod
    def put_draft(self, row: DraftRow) -> None: ...
    @abstractmethod
    def sources(self, draft_id: str) -> list[SourceRow]: ...
    @abstractmethod
    def put_source(self, row: SourceRow) -> None: ...
    @abstractmethod
    def delete_source(self, source_id: str) -> None: ...
    @abstractmethod
    def jobs(self, draft_id: str) -> list[JobRow]: ...
    @abstractmethod
    def job(self, job_id: str, *, lock: bool = False) -> JobRow | None: ...
    @abstractmethod
    def next_claimable_job(self, now: datetime) -> JobRow | None: ...
    @abstractmethod
    def put_job(self, row: JobRow) -> None: ...
    @abstractmethod
    def findings(self, draft_id: str) -> list[FindingRow]: ...
    @abstractmethod
    def put_finding(self, row: FindingRow) -> None: ...
    @abstractmethod
    def delete_findings(self, draft_id: str) -> None: ...
    @abstractmethod
    def events(self, draft_id: str) -> list[EventRow]: ...
    @abstractmethod
    def add_event(self, row: EventRow) -> None: ...


class SolutionAuthoringRepository(ABC):
    def __init__(self, clock: Callable[[], datetime] | None = None):
        self._clock = clock or (lambda: datetime.now(UTC))

    @abstractmethod
    def _transaction(self) -> AbstractContextManager[_Tx]: ...

    # ---- 草稿 ----

    def create_draft(self, draft: DraftRow) -> DraftRow:
        with self._transaction() as tx:
            tx.put_draft(draft)
            tx.add_event(self._event(draft.draft_id, "created", draft.created_by))
        return draft

    def get_draft(self, draft_id: str) -> DraftRow:
        with self._transaction() as tx:
            return self._require(tx, draft_id)

    def list_drafts(self, *, include_archived: bool = False) -> list[DraftRow]:
        with self._transaction() as tx:
            rows = [row for row in tx.drafts() if include_archived or row.status != "archived"]
        return sorted(rows, key=lambda row: row.updated_at, reverse=True)

    def update_draft(self, draft_id: str, actor_id: str, decide: Decide, *, expected_version: int | None = None) -> DraftRow:
        """锁住草稿后调用 `decide(草稿, 发现项)`；它返回的变更与审计事件一起提交，抛错则整体回滚。

        `decide` 在行锁内执行：只做判断与计算，不做 I/O。
        """
        with self._transaction() as tx:
            draft = self._require(tx, draft_id, lock=True)
            if expected_version is not None and draft.version != expected_version:
                raise Conflict("draft was modified by someone else; reload and retry")
            findings = tx.findings(draft_id)
            return self._apply(tx, draft, findings, actor_id, decide(draft, findings))

    # ---- 资料 ----

    def add_source(
        self, source: SourceRow, *, allowed_statuses: Collection[str], max_sources: int, max_total_bytes: int,
    ) -> SourceRow:
        with self._transaction() as tx:
            draft = self._require(tx, source.draft_id, lock=True)
            if draft.status not in allowed_statuses:
                raise InvalidTransition(f"sources cannot be changed while the draft is {draft.status}")
            existing = tx.sources(source.draft_id)
            if any(item.sha256 == source.sha256 for item in existing):
                raise Conflict("this file has already been uploaded to the draft")
            if len(existing) >= max_sources:
                raise ValidationProblem(f"a draft accepts at most {max_sources} source documents")
            if sum(item.size_bytes for item in existing) + source.size_bytes > max_total_bytes:
                raise RequestTooLarge("source documents exceed the total size limit for a draft")
            row = replace(source, seq=max((item.seq for item in existing), default=0) + 1)
            tx.put_source(row)
            return row

    def list_sources(self, draft_id: str) -> list[SourceRow]:
        with self._transaction() as tx:
            self._require(tx, draft_id)
            return sorted(tx.sources(draft_id), key=lambda row: row.seq)

    def remove_source(self, draft_id: str, source_id: str, *, allowed_statuses: Collection[str]) -> SourceRow:
        with self._transaction() as tx:
            draft = self._require(tx, draft_id, lock=True)
            if draft.status not in allowed_statuses:
                raise InvalidTransition(f"sources cannot be changed while the draft is {draft.status}")
            row = next((item for item in tx.sources(draft_id) if item.source_id == source_id), None)
            if row is None:
                raise NotFound("source document not found")
            tx.delete_source(source_id)
            return row

    def set_source_result(self, draft_id: str, source_id: str, **changes: Any) -> None:
        with self._transaction() as tx:
            row = next((item for item in tx.sources(draft_id) if item.source_id == source_id), None)
            if row is not None:
                tx.put_source(replace(row, **changes))

    def purge_sources(self, draft_id: str) -> list[SourceRow]:
        """删除草稿的全部资料行，返回被删的行（调用方据此清理文件）。"""
        with self._transaction() as tx:
            self._require(tx, draft_id, lock=True)
            rows = tx.sources(draft_id)
            for row in rows:
                tx.delete_source(row.source_id)
            return rows

    # ---- 生成任务 ----

    def enqueue_job(self, job: JobRow, *, allowed_statuses: Collection[str]) -> tuple[JobRow, bool]:
        """入队并把草稿置为 generating。返回 (任务, 是否新建)；同一幂等键重复请求返回原任务。"""
        with self._transaction() as tx:
            draft = self._require(tx, job.draft_id, lock=True)
            jobs = tx.jobs(job.draft_id)
            if job.idempotency_key:
                for existing in jobs:
                    if existing.idempotency_key == job.idempotency_key:
                        return existing, False
            if any(existing.status in ACTIVE_JOB_STATUSES for existing in jobs):
                raise Conflict("a generation job is already running for this draft")
            if draft.status not in allowed_statuses:
                raise InvalidTransition(f"generation cannot start while the draft is {draft.status}")
            if not tx.sources(job.draft_id):
                raise ValidationProblem("upload at least one source document before generating")
            tx.put_job(job)
            change = DraftChange(changes={"status": "generating"}, event=("generation_requested", ""))
            self._apply(tx, draft, [], job.created_by, change)
            return job, True

    def get_job(self, draft_id: str, job_id: str) -> JobRow:
        with self._transaction() as tx:
            job = tx.job(job_id)
        if job is None or job.draft_id != draft_id:
            raise NotFound("generation job not found")
        return job

    def latest_job(self, draft_id: str) -> JobRow | None:
        with self._transaction() as tx:
            jobs = tx.jobs(draft_id)
        return max(jobs, key=lambda row: row.created_at, default=None)

    def claim_job(self, owner: str, lease_seconds: float) -> JobRow | None:
        """领取一个排队中的任务，或租约已过期（上一个执行者失联）的任务。"""
        with self._transaction() as tx:
            now = self._clock()
            job = tx.next_claimable_job(now)
            if job is None:
                return None
            claimed = replace(
                job, status="parsing", attempt=job.attempt + 1, lease_owner=owner,
                lease_expires_at=now + timedelta(seconds=lease_seconds), started_at=job.started_at or now,
            )
            tx.put_job(claimed)
            return claimed

    def heartbeat_job(self, job_id: str, owner: str, lease_seconds: float, *, status: str | None = None) -> bool:
        """续租并可选推进阶段。返回 False 表示任务已不归该执行者（应停止并丢弃结果）。"""
        with self._transaction() as tx:
            job = tx.job(job_id, lock=True)
            if job is None or not _owned(job, owner):
                return False
            tx.put_job(replace(job, status=status or job.status, lease_expires_at=self._clock() + timedelta(seconds=lease_seconds)))
            return True

    def complete_job(self, draft_id: str, job_id: str, owner: str, *, change: DraftChange, usage: dict[str, Any]) -> bool:
        """任务成功：任务置 succeeded 并与草稿内容一起提交。租约已丢失则什么都不写，返回 False。"""
        with self._transaction() as tx:
            draft = self._require(tx, draft_id, lock=True)
            job = tx.job(job_id, lock=True)
            if job is None or job.draft_id != draft_id or not _owned(job, owner):
                return False
            tx.put_job(replace(
                job, status="succeeded", lease_owner=None, lease_expires_at=None, usage=usage,
                error_code=None, error_message=None, finished_at=self._clock(),
            ))
            self._apply(tx, draft, tx.findings(draft_id), job.created_by, change)
            return True

    def fail_job(
        self, draft_id: str, job_id: str, owner: str, *, error_code: str, error_message: str, usage: dict[str, Any],
    ) -> bool:
        """任务失败：不写任何生成内容，草稿回到生成前可用的状态。"""
        with self._transaction() as tx:
            draft = self._require(tx, draft_id, lock=True)
            job = tx.job(job_id, lock=True)
            if job is None or job.draft_id != draft_id or not _owned(job, owner):
                return False
            tx.put_job(replace(
                job, status="failed", lease_owner=None, lease_expires_at=None, usage=usage,
                error_code=error_code, error_message=error_message, finished_at=self._clock(),
            ))
            restored = "ready_for_review" if draft.package is not None else "draft"
            change = DraftChange(changes={"status": restored}, event=("generation_failed", error_code))
            self._apply(tx, draft, [], job.created_by, change)
            return True

    # ---- 发现项 / 审计 ----

    def list_findings(self, draft_id: str) -> list[FindingRow]:
        with self._transaction() as tx:
            return sorted(tx.findings(draft_id), key=lambda row: (row.created_at, row.finding_id))

    def list_events(self, draft_id: str) -> list[EventRow]:
        with self._transaction() as tx:
            return sorted(tx.events(draft_id), key=lambda row: row.created_at)

    # ---- 内部 ----

    @staticmethod
    def _require(tx: _Tx, draft_id: str, *, lock: bool = False) -> DraftRow:
        draft = tx.draft(draft_id, lock=lock)
        if draft is None:
            raise NotFound("solution draft not found")
        return draft

    def _event(self, draft_id: str, action: str, actor_id: str, summary: str = "") -> EventRow:
        return EventRow(
            event_id=str(uuid.uuid4()), draft_id=draft_id, action=action, actor_id=actor_id,
            created_at=self._clock(), summary=summary[:300],
        )

    def _apply(self, tx: _Tx, draft: DraftRow, findings: list[FindingRow], actor_id: str, change: DraftChange) -> DraftRow:
        updated = replace(draft, **change.changes, version=draft.version + 1, updated_by=actor_id, updated_at=self._clock())
        tx.put_draft(updated)
        if change.replace_findings:
            tx.delete_findings(draft.draft_id)
        else:
            current = {row.finding_id: row for row in findings}
            for finding_id, values in change.finding_updates.items():
                if finding_id in current:
                    tx.put_finding(replace(current[finding_id], **values))
        for row in change.new_findings:
            tx.put_finding(row)
        if change.event is not None:
            tx.add_event(self._event(draft.draft_id, change.event[0], actor_id, change.event[1]))
        return updated


def _owned(job: JobRow, owner: str) -> bool:
    return job.lease_owner == owner and job.status in ACTIVE_JOB_STATUSES


# ---- 内存后端（dev / 测试；无 OPERATION_DB_URL 时使用）----

@dataclass
class _MemoryStore:
    drafts: dict[str, DraftRow] = field(default_factory=dict)
    sources: dict[str, SourceRow] = field(default_factory=dict)
    jobs: dict[str, JobRow] = field(default_factory=dict)
    findings: dict[str, FindingRow] = field(default_factory=dict)
    events: list[EventRow] = field(default_factory=list)

    def snapshot(self) -> "_MemoryStore":
        # 行都是不可变对象：浅拷贝容器即可回滚。
        return _MemoryStore(dict(self.drafts), dict(self.sources), dict(self.jobs), dict(self.findings), list(self.events))

    def restore(self, other: "_MemoryStore") -> None:
        self.drafts, self.sources, self.jobs = other.drafts, other.sources, other.jobs
        self.findings, self.events = other.findings, other.events


class _MemoryTx(_Tx):
    def __init__(self, store: _MemoryStore):
        self._store = store

    def draft(self, draft_id: str, *, lock: bool = False) -> DraftRow | None:
        return self._store.drafts.get(draft_id)

    def drafts(self) -> list[DraftRow]:
        return list(self._store.drafts.values())

    def put_draft(self, row: DraftRow) -> None:
        self._store.drafts[row.draft_id] = row

    def sources(self, draft_id: str) -> list[SourceRow]:
        return [row for row in self._store.sources.values() if row.draft_id == draft_id]

    def put_source(self, row: SourceRow) -> None:
        self._store.sources[row.source_id] = row

    def delete_source(self, source_id: str) -> None:
        self._store.sources.pop(source_id, None)

    def jobs(self, draft_id: str) -> list[JobRow]:
        return [row for row in self._store.jobs.values() if row.draft_id == draft_id]

    def job(self, job_id: str, *, lock: bool = False) -> JobRow | None:
        return self._store.jobs.get(job_id)

    def next_claimable_job(self, now: datetime) -> JobRow | None:
        claimable = [
            row for row in self._store.jobs.values()
            if row.status == "queued"
            or (row.status in ACTIVE_JOB_STATUSES and row.lease_expires_at is not None and row.lease_expires_at < now)
        ]
        return min(claimable, key=lambda row: row.created_at, default=None)

    def put_job(self, row: JobRow) -> None:
        self._store.jobs[row.job_id] = row

    def findings(self, draft_id: str) -> list[FindingRow]:
        return [row for row in self._store.findings.values() if row.draft_id == draft_id]

    def put_finding(self, row: FindingRow) -> None:
        self._store.findings[row.finding_id] = row

    def delete_findings(self, draft_id: str) -> None:
        self._store.findings = {key: row for key, row in self._store.findings.items() if row.draft_id != draft_id}

    def events(self, draft_id: str) -> list[EventRow]:
        return [row for row in self._store.events if row.draft_id == draft_id]

    def add_event(self, row: EventRow) -> None:
        self._store.events.append(row)


class MemorySolutionAuthoringRepository(SolutionAuthoringRepository):
    def __init__(self, clock: Callable[[], datetime] | None = None):
        super().__init__(clock)
        self._store = _MemoryStore()
        self._lock = threading.RLock()

    @contextmanager
    def _transaction(self) -> Iterator[_Tx]:
        with self._lock:
            snapshot = self._store.snapshot()
            try:
                yield _MemoryTx(self._store)
            except BaseException:
                self._store.restore(snapshot)
                raise
