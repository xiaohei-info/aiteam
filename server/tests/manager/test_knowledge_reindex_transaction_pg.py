"""S05's last producer seam: receipt/document/job commit, replay and exact linkage."""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import pytest

from manager_service.knowledge_intake_recovery import KnowledgeIntakeRecovery
from manager_service.knowledge_intake_service import _fingerprint, KnowledgeReconciliationRequired
from shared.errors import Conflict
from tests.manager.test_knowledge_intake_recovery_pg import Crash, SPACE, recovery_pg

pytestmark = pytest.mark.integration


def ready_document(f):
    doc, job = f.prepare()
    KnowledgeIntakeRecovery(f.service).process(f.ctx, job_id=job.id)
    assert f.service._doc_repo.get(f.ctx, document_id=doc.id).status == "ready"
    return doc, job


def receipts(f):
    with f.router.session(f.ctx) as s:
        return s.execute("SELECT id, document_id, status FROM knowledge_document_operation ORDER BY created_at").fetchall()


class FaultRouter:
    def __init__(self, base, point):
        self.base, self.point = base, point

    @contextmanager
    def session(self, ctx):
        point = self.point
        with self.base.session(ctx) as s:
            class Proxy:
                def execute(self, query, params=None):
                    cursor = s.execute(query, params)
                    if ((point == "receipt" and query.startswith("INSERT INTO knowledge_document_operation")) or
                        (point == "document" and "UPDATE knowledge_document SET status='reindex_requested'" in query) or
                        (point == "job" and query.startswith("INSERT INTO knowledge_ingestion_job"))):
                        raise Crash(point)
                    return cursor
            yield Proxy()
            if point == "before_commit":
                raise Crash(point)
        if point == "after_commit":
            raise Crash(point)


@pytest.mark.parametrize("point", ["receipt", "document", "job", "before_commit"])
def test_reindex_fault_before_commit_rolls_back_receipt_document_and_job(recovery_pg, monkeypatch, point):
    f = recovery_pg
    doc, original_job = ready_document(f)
    monkeypatch.setattr(f.service._job_repo, "_router", FaultRouter(f.router, point))
    with pytest.raises(Crash):
        f.service.reindex(f.ctx, knowledge_space_id=SPACE, document_id=doc.id, idempotency_key="atomic-fault")
    assert receipts(f) == []
    assert f.service._doc_repo.get(f.ctx, document_id=doc.id).status == "ready"
    assert [job.id for job in f.build()._job_repo.list_by_document(f.ctx, document_id=doc.id)] == [original_job.id]
    assert f.upstream.posts == 1  # initial upload only; delivery never ran inside the transaction


def test_lost_response_after_commit_replays_same_linked_job_then_recovers(recovery_pg, monkeypatch):
    f = recovery_pg
    doc, original_job = ready_document(f)
    monkeypatch.setattr(f.service._job_repo, "_router", FaultRouter(f.router, "after_commit"))
    with pytest.raises(Crash):
        f.service.reindex(f.ctx, knowledge_space_id=SPACE, document_id=doc.id, idempotency_key="lost-response")
    restarted = f.build()
    first_receipt = restarted._operation_repo.get_by_key(f.ctx, operation="reindex", idempotency_key="lost-response")
    jobs = restarted._job_repo.list_by_document(f.ctx, document_id=doc.id)
    assert len(jobs) == 2 and jobs[-1].operation_id == first_receipt.id
    assert jobs[-1].submission_state == "not_submitted" and f.upstream.posts == 1
    f.app.state._knowledge_intake_service = restarted
    response = f.client.post(f"{f.path}/{doc.id}/reindex", headers={**f.headers, "Idempotency-Key": "lost-response"})
    assert response.status_code == 202, response.text
    assert response.json()["data"]["operation_id"] == first_receipt.id
    assert len(restarted._job_repo.list_by_document(f.ctx, document_id=doc.id)) == 2
    assert f.upstream.posts == 1
    assert KnowledgeIntakeRecovery(restarted).process(f.ctx, job_id=jobs[-1].id)
    replay = restarted.reindex(f.ctx, knowledge_space_id=SPACE, document_id=doc.id, idempotency_key="lost-response")
    assert replay.operation_id == first_receipt.id and replay.status == "completed"
    assert f.upstream.posts == 2 and len(receipts(f)) == 1


@pytest.mark.parametrize("same_key", [True, False])
def test_concurrent_reindex_keys_have_one_job_and_no_cas_loser_receipt(recovery_pg, same_key):
    f = recovery_pg
    doc, original_job = ready_document(f)
    barrier = threading.Barrier(2)
    inserted = threading.Barrier(2)
    class CompetingReceiptRouter:
        @contextmanager
        def session(self, ctx):
            with f.router.session(ctx) as session:
                class Proxy:
                    def execute(self, query, params=None):
                        result = session.execute(query, params)
                        if query.startswith("INSERT INTO knowledge_document_operation"):
                            # Both distinct-key receipts exist uncommitted before
                            # either document CAS: the loser must roll its INSERT back.
                            inserted.wait(timeout=5)
                        return result
                yield Proxy()
    def request(index):
        service = f.build()
        if not same_key:
            service._job_repo._router = CompetingReceiptRouter()
        # Isolate producer concurrency. The durable worker runs only after both
        # requests finish, so no native completion can admit a second generation.
        service._advance = lambda *args, **kwargs: None
        barrier.wait()
        try:
            return service.reindex(f.ctx, knowledge_space_id=SPACE, document_id=doc.id,
                                   idempotency_key="same" if same_key else f"competing-{index}")
        except Conflict as error:
            return error
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(request, (1, 2)))
    accepted = [result for result in results if not isinstance(result, Conflict)]
    assert len(accepted) == (2 if same_key else 1)
    assert len({result.operation_id for result in accepted}) == 1
    assert len(receipts(f)) == 1
    jobs = f.service._job_repo.list_by_document(f.ctx, document_id=doc.id)
    assert len(jobs) == 2 and jobs[-1].operation_id == accepted[0].operation_id
    assert f.upstream.posts == 1
    KnowledgeIntakeRecovery(f.build()).process(f.ctx, job_id=jobs[-1].id)
    assert f.upstream.posts == 2


def test_same_key_different_fingerprint_rejected_and_other_tenant_cannot_observe(recovery_pg):
    f = recovery_pg
    first, _ = ready_document(f)
    second, second_job = ready_document(f)
    completed = f.service.reindex(f.ctx, knowledge_space_id=SPACE, document_id=first.id, idempotency_key="fixed-key")
    assert completed.status == "completed"
    with pytest.raises(Conflict):
        f.build().reindex(f.ctx, knowledge_space_id=SPACE, document_id=second.id, idempotency_key="fixed-key")
    assert len(receipts(f)) == 1
    assert f.service._doc_repo.get(f.ctx, document_id=second.id).status == "ready"
    assert [job.id for job in f.service._job_repo.list_by_document(f.ctx, document_id=second.id)] == [second_job.id]
    assert f.service._operation_repo.get_by_key(f.other, operation="reindex", idempotency_key="fixed-key") is None
    assert f.upstream.posts == 3


def test_completed_receipt_replay_does_not_execute_after_document_changes(recovery_pg):
    f = recovery_pg
    doc, _ = ready_document(f)
    done = f.service.reindex(f.ctx, knowledge_space_id=SPACE, document_id=doc.id, idempotency_key="completed-key")
    f.service._doc_repo.update_status(f.ctx, doc.id, status="failed", error_code="SUBMISSION_UNKNOWN")
    replay = f.build().reindex(f.ctx, knowledge_space_id=SPACE, document_id=doc.id, idempotency_key="completed-key")
    assert replay.operation_id == done.operation_id and replay.status == "completed"
    assert replay.document_status == "failed" and f.upstream.posts == 2
    with pytest.raises(KnowledgeReconciliationRequired):
        f.build().reindex(f.ctx, knowledge_space_id=SPACE, document_id=doc.id, idempotency_key="new-key")
    assert len(receipts(f)) == 1


@pytest.mark.parametrize("operation_status", ["pending", "accepted"])
def test_legacy_pending_receipt_does_not_adopt_an_unrelated_document_job(recovery_pg, operation_status):
    f = recovery_pg
    doc, original_job = ready_document(f)
    legacy = f.service._operation_repo.create(f.ctx, knowledge_space_id=SPACE, document_id=doc.id,
        operation="reindex", idempotency_key="legacy", request_fingerprint=_fingerprint("reindex", SPACE, doc.id), status=operation_status)
    response = f.client.post(f"{f.path}/{doc.id}/reindex", headers={**f.headers, "Idempotency-Key": "legacy"})
    assert response.status_code == 409 and response.json()["code"] == "knowledge_reconciliation_required"
    jobs = f.service._job_repo.list_by_document(f.ctx, document_id=doc.id)
    assert [job.id for job in jobs] == [original_job.id] and jobs[0].operation_id is None
    assert receipts(f)[0][2] == operation_status and f.upstream.posts == 1
    assert f.service._operation_repo.get_by_key(f.ctx, operation="reindex", idempotency_key="legacy").id == legacy.id


@pytest.mark.parametrize("association", ["wrong_document", "duplicate"])
def test_ambiguous_receipt_job_link_fails_closed_without_reassignment(recovery_pg, association):
    f = recovery_pg
    first, _ = ready_document(f)
    second, _ = ready_document(f)
    legacy = f.service._operation_repo.create(f.ctx, knowledge_space_id=SPACE, document_id=first.id,
        operation="reindex", idempotency_key="bad-link", request_fingerprint=_fingerprint("reindex", SPACE, first.id))
    for _ in range(2 if association == "duplicate" else 1):
        f.service._job_repo.create(f.ctx, knowledge_space_id=SPACE,
            document_id=first.id if association == "duplicate" else second.id, status="done", operation_id=legacy.id)
    before = f.service._job_repo.list_by_space(f.ctx, knowledge_space_id=SPACE)
    with pytest.raises(KnowledgeReconciliationRequired):
        f.build().reindex(f.ctx, knowledge_space_id=SPACE, document_id=first.id, idempotency_key="bad-link")
    assert f.service._job_repo.list_by_space(f.ctx, knowledge_space_id=SPACE) == before
    assert f.upstream.posts == 2 and receipts(f)[0][2] == "pending"


def test_reindex_same_key_unknown_submission_stays_protected_until_reconciled(recovery_pg):
    f = recovery_pg
    doc, _ = ready_document(f)
    f.upstream.after_post = lambda: (_ for _ in ()).throw(Crash("accepted without receipt"))
    with pytest.raises(Crash):
        f.service.reindex(f.ctx, knowledge_space_id=SPACE, document_id=doc.id, idempotency_key="unknown-key")
    f.upstream.after_post = None
    job = f.service._job_repo.get_latest_by_document(f.ctx, document_id=doc.id)
    assert job.operation_id is not None and job.submission_state == "submitted"
    f.upstream.hidden = True
    f.due(job.id, attempts=5)
    KnowledgeIntakeRecovery(f.build()).process(f.ctx, job_id=job.id)
    with pytest.raises(KnowledgeReconciliationRequired):
        f.build().reindex(f.ctx, knowledge_space_id=SPACE, document_id=doc.id, idempotency_key="unknown-key")
    assert f.upstream.posts == 2 and len(receipts(f)) == 1
    f.upstream.hidden = False
    f.due(job.id)
    KnowledgeIntakeRecovery(f.build()).process(f.ctx, job_id=job.id)
    replay = f.build().reindex(f.ctx, knowledge_space_id=SPACE, document_id=doc.id, idempotency_key="unknown-key")
    assert replay.status == "completed" and replay.operation_id == job.operation_id
    assert f.upstream.posts == 2
