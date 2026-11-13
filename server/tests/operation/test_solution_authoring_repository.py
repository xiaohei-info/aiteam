"""行业文档生成仓储：幂等、状态闸门、乐观版本、任务租约。

同一组用例跑两个后端：内存（始终）与 PostgreSQL（配置了 OPERATION_ADMIN_DB_URL / OPERATION_DB_URL 时）。
"""

from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from operation_service.solution_authoring_repository import (
    DraftChange,
    DraftRow,
    FindingRow,
    JobRow,
    MemorySolutionAuthoringRepository,
    SolutionAuthoringRepository,
    SourceRow,
)
from shared.errors import Conflict, InvalidTransition, NotFound, RequestTooLarge, ValidationProblem

ADMIN_DB_URL = os.getenv("OPERATION_ADMIN_DB_URL") or os.getenv("OPER_TEST_ADMIN_DB_URL")
APP_DB_URL = os.getenv("OPERATION_DB_URL") or os.getenv("OPER_TEST_DB_URL")
APP_RW_PASSWORD = os.getenv("OPER_TEST_APP_RW_PASSWORD") or os.getenv("APP_RW_PASSWORD", "test_password")

_TABLES = (
    "solution_review_event", "solution_sensitive_finding", "solution_generation_job",
    "solution_source_document", "solution_draft",
)
EDITABLE = ("draft", "ready_for_review", "rejected")


class Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 11, 12, 8, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        # 每次调用前进 1 毫秒：排序稳定，且与真实时钟一样单调。
        self.now += timedelta(milliseconds=1)
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture(params=["memory", pytest.param("pg", marks=pytest.mark.integration)])
def repo(request, clock) -> SolutionAuthoringRepository:
    if request.param == "memory":
        return MemorySolutionAuthoringRepository(clock)
    if not ADMIN_DB_URL or not APP_DB_URL:
        pytest.skip("PostgreSQL integration test requires OPERATION_ADMIN_DB_URL/OPERATION_DB_URL")
    import psycopg

    from operation_service.repository import apply_migrations
    from operation_service.solution_authoring_repository_pg import PgSolutionAuthoringRepository

    apply_migrations(ADMIN_DB_URL, APP_RW_PASSWORD)
    with psycopg.connect(ADMIN_DB_URL, autocommit=True) as conn:
        conn.execute(f"TRUNCATE {', '.join(_TABLES)}")
    return PgSolutionAuthoringRepository(APP_DB_URL, clock)


def _id() -> str:
    return str(uuid.uuid4())


def _draft(repo, clock, **overrides) -> DraftRow:
    now = clock()
    values = {
        "draft_id": _id(), "title": "质检方案", "model_provider_id": "provider-1", "model_id": "model-1",
        "created_by": "op1", "updated_by": "op1", "created_at": now, "updated_at": now, **overrides,
    }
    return repo.create_draft(DraftRow(**values))


def _source(repo, clock, draft_id: str, *, sha: str = "a" * 64, size: int = 100, **limits) -> SourceRow:
    row = SourceRow(
        source_id=_id(), draft_id=draft_id, file_name="质量手册.docx", size_bytes=size, sha256=sha,
        storage_key=f"{draft_id}/{sha[:8]}", created_by="op1", created_at=clock(),
    )
    options = {"allowed_statuses": EDITABLE, "max_sources": 3, "max_total_bytes": 1000, **limits}
    return repo.add_source(row, **options)


def _job(clock, draft_id: str, key: str | None = None) -> JobRow:
    return JobRow(job_id=_id(), draft_id=draft_id, created_by="op1", created_at=clock(), idempotency_key=key)


def _queued(repo, clock, key: str | None = "k1") -> tuple[DraftRow, JobRow]:
    draft = _draft(repo, clock)
    _source(repo, clock, draft.draft_id)
    job, created = repo.enqueue_job(_job(clock, draft.draft_id, key), allowed_statuses=EDITABLE)
    assert created
    return draft, job


def _finding(clock, draft_id: str, **overrides) -> FindingRow:
    values = {
        "finding_id": _id(), "draft_id": draft_id, "kind": "phone", "origin": "rule", "created_at": clock(),
        "field_path": "description", "excerpt": "13800001111", "masked": "1*********1", **overrides,
    }
    return FindingRow(**values)


# ---- 草稿 ----

def test_create_get_and_list_hide_archived_and_sort_by_recent_update(repo, clock):
    first = _draft(repo, clock, title="一")
    second = _draft(repo, clock, title="二")
    archived = _draft(repo, clock, title="三", status="archived")
    assert repo.get_draft(first.draft_id) == first
    assert [row.title for row in repo.list_drafts()] == ["二", "一"]
    assert [row.title for row in repo.list_drafts(include_archived=True)] == ["三", "二", "一"]
    assert [(event.action, event.actor_id) for event in repo.list_events(archived.draft_id)] == [("created", "op1")]
    assert second.version == 1 and second.package is None and second.evidence_sources == {}


def test_missing_draft_is_not_found(repo):
    with pytest.raises(NotFound):
        repo.get_draft(_id())
    with pytest.raises(NotFound):
        repo.update_draft(_id(), "op1", lambda draft, findings: DraftChange())
    with pytest.raises(NotFound):
        repo.list_sources(_id())


def test_update_bumps_version_records_actor_and_event_and_roundtrips_json(repo, clock):
    draft = _draft(repo, clock)
    package = {"display_name": "质检方案", "experts": [{"key": "lead"}], "tags": ["质检"]}
    updated = repo.update_draft(
        draft.draft_id, "op2",
        lambda current, findings: DraftChange(
            changes={"package": package, "status": "ready_for_review", "warnings": ["text_truncated"]},
            event=("package_edited", "2 fields"),
        ),
        expected_version=1,
    )
    stored = repo.get_draft(draft.draft_id)
    assert stored == updated
    assert (stored.version, stored.updated_by, stored.status) == (2, "op2", "ready_for_review")
    assert stored.package == package and stored.warnings == ["text_truncated"]
    assert stored.updated_at > draft.updated_at and stored.created_by == "op1"
    assert [(e.action, e.actor_id, e.summary) for e in repo.list_events(draft.draft_id)] == [
        ("created", "op1", ""), ("package_edited", "op2", "2 fields"),
    ]


def test_stale_version_is_rejected_without_calling_decide(repo, clock):
    draft = _draft(repo, clock)
    repo.update_draft(draft.draft_id, "op1", lambda current, findings: DraftChange(changes={"title": "新"}))
    called = []
    with pytest.raises(Conflict):
        repo.update_draft(draft.draft_id, "op2", lambda c, f: called.append(1) or DraftChange(), expected_version=1)
    assert called == [] and repo.get_draft(draft.draft_id).version == 2


def test_a_failing_decide_rolls_everything_back(repo, clock):
    draft = _draft(repo, clock)

    def decide(current, findings):
        raise InvalidTransition("no")

    with pytest.raises(InvalidTransition):
        repo.update_draft(draft.draft_id, "op2", decide)
    assert repo.get_draft(draft.draft_id) == draft
    assert len(repo.list_events(draft.draft_id)) == 1


def test_findings_are_added_updated_and_replaced_with_the_draft(repo, clock):
    draft = _draft(repo, clock)
    first, second = _finding(clock, draft.draft_id), _finding(clock, draft.draft_id, kind="email", excerpt="a@b.cn")
    repo.update_draft(draft.draft_id, "op1", lambda current, findings: DraftChange(new_findings=[first, second]))
    assert [row.finding_id for row in repo.list_findings(draft.draft_id)] == [first.finding_id, second.finding_id]

    seen: list[int] = []
    resolved_at = clock()

    def resolve(current, findings):
        seen.append(len(findings))
        return DraftChange(finding_updates={
            first.finding_id: {"status": "redacted", "resolved_by": "op2", "resolved_at": resolved_at},
            _id(): {"status": "removed"},  # 不存在的发现项被忽略
        })

    repo.update_draft(draft.draft_id, "op2", resolve)
    rows = {row.finding_id: row for row in repo.list_findings(draft.draft_id)}
    assert seen == [2]
    assert (rows[first.finding_id].status, rows[first.finding_id].resolved_by, rows[first.finding_id].resolved_at) == ("redacted", "op2", resolved_at)
    assert rows[second.finding_id].status == "open" and rows[first.finding_id].excerpt == "13800001111"

    fresh = _finding(clock, draft.draft_id, kind="company", origin="agent")
    repo.update_draft(draft.draft_id, "op1", lambda current, findings: DraftChange(new_findings=[fresh], replace_findings=True))
    assert [row.finding_id for row in repo.list_findings(draft.draft_id)] == [fresh.finding_id]


# ---- 资料 ----

def test_sources_get_increasing_seq_that_is_not_reused_after_removal(repo, clock):
    draft = _draft(repo, clock)
    one = _source(repo, clock, draft.draft_id, sha="a" * 64)
    two = _source(repo, clock, draft.draft_id, sha="b" * 64)
    assert (one.seq, two.seq) == (1, 2)
    removed = repo.remove_source(draft.draft_id, one.source_id, allowed_statuses=EDITABLE)
    assert removed.storage_key == one.storage_key
    three = _source(repo, clock, draft.draft_id, sha="c" * 64)
    assert [(row.seq, row.sha256[0]) for row in repo.list_sources(draft.draft_id)] == [(2, "b"), (3, "c")]
    assert three.seq == 3


def test_source_limits_and_duplicates(repo, clock):
    draft = _draft(repo, clock)
    _source(repo, clock, draft.draft_id, sha="a" * 64, size=600)
    with pytest.raises(Conflict):
        _source(repo, clock, draft.draft_id, sha="a" * 64)
    with pytest.raises(RequestTooLarge):
        _source(repo, clock, draft.draft_id, sha="b" * 64, size=401)
    _source(repo, clock, draft.draft_id, sha="b" * 64, size=400)
    with pytest.raises(ValidationProblem):
        _source(repo, clock, draft.draft_id, sha="c" * 64, size=0, max_sources=2)
    assert len(repo.list_sources(draft.draft_id)) == 2


def test_sources_are_frozen_outside_editable_states(repo, clock):
    draft = _draft(repo, clock, status="in_review")
    with pytest.raises(InvalidTransition):
        _source(repo, clock, draft.draft_id)
    editable = _draft(repo, clock)
    source = _source(repo, clock, editable.draft_id)
    with pytest.raises(InvalidTransition):
        repo.remove_source(editable.draft_id, source.source_id, allowed_statuses=("approved",))
    with pytest.raises(NotFound):
        repo.remove_source(editable.draft_id, _id(), allowed_statuses=EDITABLE)


def test_source_result_and_purge(repo, clock):
    draft = _draft(repo, clock)
    one = _source(repo, clock, draft.draft_id, sha="a" * 64)
    _source(repo, clock, draft.draft_id, sha="b" * 64)
    repo.set_source_result(draft.draft_id, one.source_id, status="parsed", chunk_count=7, image_count=2, warnings=["image_skipped"])
    repo.set_source_result(draft.draft_id, _id(), status="failed")  # 已被删掉的资料：忽略
    stored = repo.list_sources(draft.draft_id)[0]
    assert (stored.status, stored.chunk_count, stored.image_count, stored.warnings) == ("parsed", 7, 2, ["image_skipped"])
    assert sorted(row.sha256[0] for row in repo.purge_sources(draft.draft_id)) == ["a", "b"]
    assert repo.list_sources(draft.draft_id) == []


# ---- 任务：入队 ----

def test_enqueue_requires_sources_and_an_editable_draft(repo, clock):
    draft = _draft(repo, clock)
    with pytest.raises(ValidationProblem):
        repo.enqueue_job(_job(clock, draft.draft_id), allowed_statuses=EDITABLE)
    _source(repo, clock, draft.draft_id)
    with pytest.raises(InvalidTransition):
        repo.enqueue_job(_job(clock, draft.draft_id), allowed_statuses=("approved",))
    assert repo.get_draft(draft.draft_id).status == "draft" and repo.latest_job(draft.draft_id) is None


def test_enqueue_marks_the_draft_generating_and_is_idempotent_per_key(repo, clock):
    draft, job = _queued(repo, clock, "k1")
    assert repo.get_draft(draft.draft_id).status == "generating"
    assert repo.get_job(draft.draft_id, job.job_id).status == "queued"

    again, created = repo.enqueue_job(_job(clock, draft.draft_id, "k1"), allowed_statuses=EDITABLE)
    assert (again.job_id, created) == (job.job_id, False)
    with pytest.raises(Conflict):
        repo.enqueue_job(_job(clock, draft.draft_id, "k2"), allowed_statuses=EDITABLE)
    with pytest.raises(Conflict):
        repo.enqueue_job(_job(clock, draft.draft_id), allowed_statuses=EDITABLE)
    assert [event.action for event in repo.list_events(draft.draft_id)] == ["created", "generation_requested"]
    with pytest.raises(NotFound):
        repo.get_job(_id(), job.job_id)


# ---- 任务：租约 ----

def test_claim_takes_the_oldest_queued_job_once(repo, clock):
    _, first = _queued(repo, clock)
    _, second = _queued(repo, clock)
    claimed = repo.claim_job("w1", 60)
    assert claimed is not None
    assert (claimed.job_id, claimed.status, claimed.attempt, claimed.lease_owner) == (first.job_id, "parsing", 1, "w1")
    assert claimed.started_at is not None and claimed.lease_expires_at is not None
    other = repo.claim_job("w2", 60)
    assert other is not None and other.job_id == second.job_id
    assert repo.claim_job("w3", 60) is None


def test_heartbeat_extends_the_lease_and_advances_the_stage(repo, clock):
    draft, job = _queued(repo, clock)
    repo.claim_job("w1", 60)
    clock.advance(50)
    assert repo.heartbeat_job(job.job_id, "w1", 60, status="analyzing") is True
    clock.advance(50)
    assert repo.claim_job("w2", 60) is None  # 续租后仍在租期内
    assert repo.get_job(draft.draft_id, job.job_id).status == "analyzing"
    assert repo.heartbeat_job(job.job_id, "w2", 60) is False
    assert repo.heartbeat_job(_id(), "w1", 60) is False


def test_an_expired_lease_is_taken_over_and_the_old_owner_can_no_longer_write(repo, clock):
    draft, job = _queued(repo, clock)
    repo.claim_job("w1", 60)
    clock.advance(61)
    taken = repo.claim_job("w2", 60)
    assert taken is not None and (taken.job_id, taken.attempt, taken.lease_owner) == (job.job_id, 2, "w2")

    change = DraftChange(changes={"package": {"display_name": "旧执行者的结果"}, "status": "ready_for_review"})
    assert repo.heartbeat_job(job.job_id, "w1", 60) is False
    assert repo.complete_job(draft.draft_id, job.job_id, "w1", change=change, usage={}) is False
    assert repo.fail_job(draft.draft_id, job.job_id, "w1", error_code="timeout", error_message="x", usage={}) is False
    stored = repo.get_draft(draft.draft_id)
    assert stored.package is None and stored.status == "generating"
    assert repo.get_job(draft.draft_id, job.job_id).status == "parsing"


# ---- 任务：结束 ----

def test_complete_commits_content_findings_and_job_together(repo, clock):
    draft, job = _queued(repo, clock)
    stale = _finding(clock, draft.draft_id)
    repo.update_draft(draft.draft_id, "op1", lambda current, findings: DraftChange(new_findings=[stale]))
    repo.claim_job("w1", 60)
    fresh = _finding(clock, draft.draft_id, kind="company", origin="agent", excerpt="某公司")
    change = DraftChange(
        changes={"package": {"display_name": "质检方案"}, "status": "ready_for_review", "prompt_version": "v1",
                 "evidence_sources": {"s1-c1": {"locator": "第 1 段"}}, "usage": {"total_tokens": 15}},
        new_findings=[fresh], replace_findings=True, event=("generation_succeeded", ""),
    )
    assert repo.complete_job(draft.draft_id, job.job_id, "w1", change=change, usage={"total_tokens": 15}) is True

    stored = repo.get_draft(draft.draft_id)
    assert (stored.status, stored.prompt_version, stored.package) == ("ready_for_review", "v1", {"display_name": "质检方案"})
    assert stored.evidence_sources == {"s1-c1": {"locator": "第 1 段"}} and stored.updated_by == "op1"
    done = repo.get_job(draft.draft_id, job.job_id)
    assert (done.status, done.lease_owner, done.usage, done.error_code) == ("succeeded", None, {"total_tokens": 15}, None)
    assert done.finished_at is not None
    assert [row.finding_id for row in repo.list_findings(draft.draft_id)] == [fresh.finding_id]
    assert [event.action for event in repo.list_events(draft.draft_id)][-1] == "generation_succeeded"
    assert repo.claim_job("w2", 60) is None
    # 结束后的任务不再接受续租或二次提交。
    assert repo.heartbeat_job(job.job_id, "w1", 60) is False
    assert repo.complete_job(draft.draft_id, job.job_id, "w1", change=change, usage={}) is False


def test_fail_writes_no_content_and_returns_a_new_draft_to_draft(repo, clock):
    draft, job = _queued(repo, clock)
    repo.claim_job("w1", 60)
    assert repo.fail_job(draft.draft_id, job.job_id, "w1", error_code="budget_exceeded", error_message="exceeded 60 turns", usage={"turns": 60}) is True
    stored = repo.get_draft(draft.draft_id)
    assert (stored.status, stored.package) == ("draft", None)
    failed = repo.latest_job(draft.draft_id)
    assert failed is not None
    assert (failed.status, failed.error_code, failed.error_message, failed.usage) == ("failed", "budget_exceeded", "exceeded 60 turns", {"turns": 60})
    assert [(e.action, e.summary) for e in repo.list_events(draft.draft_id)][-1] == ("generation_failed", "budget_exceeded")


def test_a_failed_regeneration_keeps_the_previous_content_and_a_new_job_can_be_queued(repo, clock):
    draft = _draft(repo, clock, status="ready_for_review", package={"display_name": "上一版"})
    _source(repo, clock, draft.draft_id)
    job, _ = repo.enqueue_job(_job(clock, draft.draft_id, "k1"), allowed_statuses=EDITABLE)
    repo.claim_job("w1", 60)
    repo.fail_job(draft.draft_id, job.job_id, "w1", error_code="model_error", error_message="x", usage={})
    stored = repo.get_draft(draft.draft_id)
    assert (stored.status, stored.package) == ("ready_for_review", {"display_name": "上一版"})

    retry, created = repo.enqueue_job(_job(clock, draft.draft_id, "k2"), allowed_statuses=EDITABLE)
    assert created and retry.job_id != job.job_id
    latest = repo.latest_job(draft.draft_id)
    assert latest is not None and latest.job_id == retry.job_id


# ---- 列表的最近任务与取消 ----

def test_list_with_latest_job_picks_the_newest_job_of_each_draft(repo, clock):
    bare = _draft(repo, clock, title="无任务")
    draft, first = _queued(repo, clock, "k1")
    repo.cancel_job(draft.draft_id, "op2")
    second, created = repo.enqueue_job(_job(clock, draft.draft_id, "k2"), allowed_statuses=EDITABLE)
    assert created
    pairs = {row.draft_id: job for row, job in repo.list_drafts_with_latest_job()}
    assert pairs[bare.draft_id] is None
    assert pairs[draft.draft_id].job_id == second.job_id and pairs[draft.draft_id].status == "queued"


def test_cancel_job_fails_the_active_job_and_restores_the_draft(repo, clock):
    draft, job = _queued(repo, clock)
    cancelled = repo.cancel_job(draft.draft_id, "op2")
    assert cancelled.status == "draft"
    stored = repo.get_job(draft.draft_id, job.job_id)
    assert (stored.status, stored.error_code, stored.lease_owner) == ("failed", "cancelled", None)
    assert stored.finished_at is not None
    assert repo.list_events(draft.draft_id)[-1].action == "generation_cancelled"
    assert repo.heartbeat_job(job.job_id, "w1", 60) is False
    again = repo.cancel_job(draft.draft_id, "op2")
    assert again.version == cancelled.version


def test_a_claimed_job_that_is_cancelled_cannot_be_completed(repo, clock):
    draft, job = _queued(repo, clock)
    claimed = repo.claim_job("w1", 60)
    assert claimed is not None and claimed.job_id == job.job_id
    repo.cancel_job(draft.draft_id, "op2")
    assert repo.complete_job(draft.draft_id, job.job_id, "w1", change=DraftChange(changes={"status": "ready_for_review"}), usage={}) is False
    assert repo.get_draft(draft.draft_id).status == "draft"
