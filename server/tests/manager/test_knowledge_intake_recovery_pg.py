"""S05 real registered routes + app_rw/RLS + HTTP-only LightRAG double."""
from __future__ import annotations

import json
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace as NS

import httpx
import pytest
from fastapi import APIRouter, BackgroundTasks
from fastapi.testclient import TestClient

from manager_service.knowledge_intake_recovery import KnowledgeIntakeRecovery, install_knowledge_intake_lifespan
from manager_service.knowledge_intake_service import build_knowledge_intake_service
from manager_service.knowledge_space_repository import KnowledgeSpaceRepository
from manager_service.rag import PgManagerRagService
from manager_service.rag_ingestion import LightRagIngestionClient, LightRagIngestionSettings
from manager_service.routes_knowledge_intake import build_knowledge_intake_router
from shared.app_factory import create_app
from shared.config import Settings
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter, apply_migrations
from shared.errors import Conflict
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token

pytestmark = pytest.mark.integration
SPACE = "enterprise_shared"


class Crash(BaseException):
    pass


class Upstream:
    def __init__(self):
        self.posts = 0
        self.probes = 0
        self.docs = {}
        self.tracks = {}
        self.state = "processed"
        self.after_post = None
        self.hidden = False
        self.duplicate_source = False

    def __call__(self, request):
        assert request.headers["LIGHTRAG-WORKSPACE"] == SPACE
        assert request.headers["X-API-Key"] == "fixture-only"
        if request.url.path == "/documents/text":
            self.posts += 1
            body = json.loads(request.content)
            track = f"insert_{self.posts}"
            doc = {"id": f"native-{self.posts}", "file_path": body["file_source"], "status": self.state, "chunks_count": 2}
            self.docs[doc["id"]] = doc
            self.tracks[track] = doc
            if self.after_post:
                self.after_post()
            return httpx.Response(200, json={"status": "success", "track_id": track})
        self.probes += 1
        if request.url.path.startswith("/documents/track_status/"):
            track = request.url.path.rsplit("/", 1)[1]
            docs = [] if self.hidden else [self.tracks[track]]
            return httpx.Response(200, json={"track_id": track, "documents": docs, "total_count": len(docs)})
        if request.url.path == "/documents/paginated":
            docs = [] if self.hidden else list(self.docs.values())
            if self.duplicate_source and docs:
                docs.append({**docs[0], "id": "conflicting-id"})
            return httpx.Response(200, json={"documents": docs, "pagination": {"page": 1, "page_size": 200, "total_count": len(docs), "total_pages": int(bool(docs)), "has_next": False}})
        if request.url.path == "/documents/delete_document":
            for doc_id in json.loads(request.content)["doc_ids"]:
                self.docs.pop(doc_id, None)
            return httpx.Response(200, json={"status": "deletion_started"})
        raise AssertionError(request.url.path)


@pytest.fixture
def recovery_pg(migrated_db, admin_url, two_tenants, tmp_path):
    router = PgTenantRouter(migrated_db)
    ctx = TenantContext(tenant_id=two_tenants[0], user_id=str(uuid.uuid4()), roles=["owner"])
    other = TenantContext(tenant_id=two_tenants[1], user_id=str(uuid.uuid4()), roles=["owner"])
    KnowledgeSpaceRepository(router, enterprise_workspace=SPACE).create(ctx, knowledge_space_id=SPACE, display_name="Fixture")
    upstream = Upstream()
    client = LightRagIngestionClient(LightRagIngestionSettings("https://fixture.invalid", "fixture-only", 1000, 2000, workspace=SPACE), transport=httpx.MockTransport(upstream))
    def build():
        return build_knowledge_intake_service(
            PgTenantRouter(migrated_db),
            storage_root=tmp_path,
            rag_service=PgManagerRagService(migrated_db, enterprise_workspace=SPACE),
            ingestion_client=client,
        )
    service = build()
    verifier, signer = make_inmem_verifier_and_signer()
    app = create_app(
        Settings(
            tier="manager",
            service_name="s05-fixture",
            db_url=migrated_db,
            admin_db_url=admin_url,
        ),
        APIRouter(),
    )
    app.include_router(build_knowledge_intake_router(verifier))
    app.state._knowledge_intake_service = service
    token = sign_inmem_token(signer, ctx.tenant_id, ["owner"], user_id=ctx.user_id)
    path = f"/api/manager/knowledge-spaces/{SPACE}/documents"
    def prepare(content=b"S05 synthetic knowledge"):
        return service.prepare_upload(ctx, knowledge_space_id=SPACE, display_name="fixture", file_name="fixture.txt", file_type="text/plain", content=content)
    def due(job_id, attempts=None):
        with router.session(ctx) as s:
            s.execute("UPDATE knowledge_ingestion_job SET lease_until=now()-interval '1 second', next_attempt_at=now()-interval '1 second', attempts=COALESCE(%s,attempts) WHERE id=%s", (attempts, job_id))
    try:
        yield NS(router=router, ctx=ctx, other=other, service=service, build=build, upstream=upstream, app=app,
                 client=TestClient(app), headers={"Authorization": f"Bearer {token}"}, path=path, prepare=prepare, due=due,
                 db=migrated_db, admin=admin_url)
    finally:
        client.close()
        # This test's upstream is an in-memory HTTP double. Its unfinished rows
        # must not be offered to a later test's different upstream/track dictionary.
        # Delete only this generated fixture tenant's knowledge metadata via RLS.
        with router.session(ctx) as s:
            s.execute("DELETE FROM knowledge_ingestion_job")
            s.execute("DELETE FROM knowledge_document_operation")
            s.execute("DELETE FROM knowledge_document")


def test_upload_without_background_delivery_stays_uploaded_on_stage_a_lifespan(recovery_pg, monkeypatch):
    # Stage A lifespan must not enumerate tenants or recover unbound jobs.
    # Request-created uploaded rows stay durable; explicit TenantContext
    # maintain_once remains the only recovery path until Stage E workers.
    f = recovery_pg
    tasks = []
    monkeypatch.setattr(BackgroundTasks, "add_task", lambda _self, *args, **kwargs: tasks.append((args, kwargs)))
    response = f.client.post(f.path, headers=f.headers, files={"file": ("fixture.txt", b"Saved but not dispatched", "text/plain")})
    assert response.status_code == 201, response.text
    doc = response.json()["data"]
    assert doc["status"] == "uploaded" and len(tasks) == 1 and f.upstream.posts == 0
    job = f.service._job_repo.get_latest_by_document(f.ctx, document_id=doc["id"])
    f.app.state._knowledge_intake_service = f.build()
    completed = threading.Event()
    original = f.app.state._knowledge_intake_service._binding_repo.publish_ready
    def publish(*args, **kwargs):
        result = original(*args, **kwargs)
        completed.set()
        return result
    monkeypatch.setattr(f.app.state._knowledge_intake_service._binding_repo, "publish_ready", publish)
    install_knowledge_intake_lifespan(f.app)
    with TestClient(f.app):
        assert not completed.wait(1)
        assert f.upstream.posts == 0
        persisted = f.service._doc_repo.get(f.ctx, document_id=doc["id"])
        assert persisted is not None and persisted.status == "uploaded"
    assert not completed.is_set() and f.upstream.posts == 0
    assert f.service._doc_repo.get(f.ctx, document_id=doc["id"]).status == "uploaded"
    assert f.service._job_repo.get(f.other, ingestion_id=job.id) is None
    assert KnowledgeIntakeRecovery(f.app.state._knowledge_intake_service).maintain_once(f.ctx) == 1
    assert completed.is_set() and f.upstream.posts == 1
    result = f.client.get(f"{f.path}/{doc['id']}/ingestion", headers=f.headers)
    assert result.status_code == 200 and result.json()["data"]["status"] == "done"
    assert result.json()["data"]["attempts"] == 1


@pytest.mark.parametrize("crash_at", ["before_fence", "after_fence", "post_before_receipt", "after_track"])
def test_restart_fence_windows_never_repeat_post(recovery_pg, monkeypatch, crash_at):
    f = recovery_pg
    doc, job = f.prepare()
    repo = f.service._job_repo
    if crash_at == "before_fence":
        monkeypatch.setattr(repo, "fence_submission", lambda *args, **kwargs: (_ for _ in ()).throw(Crash()))
    elif crash_at == "after_fence":
        original = repo.fence_submission
        def fenced(*args, **kwargs):
            original(*args, **kwargs)
            raise Crash()
        monkeypatch.setattr(repo, "fence_submission", fenced)
    elif crash_at == "post_before_receipt":
        f.upstream.after_post = lambda: (_ for _ in ()).throw(Crash())
    else:
        original = repo.record_track
        def recorded(*args, **kwargs):
            original(*args, **kwargs)
            raise Crash()
        monkeypatch.setattr(repo, "record_track", recorded)
    with pytest.raises(Crash):
        KnowledgeIntakeRecovery(f.service).process(f.ctx, job_id=job.id)
    posts = f.upstream.posts
    f.upstream.after_post = None
    f.due(job.id)
    recovered = f.build()
    assert KnowledgeIntakeRecovery(recovered).process(f.ctx, job_id=job.id)
    result = recovered.get_document(f.ctx, knowledge_space_id=SPACE, document_id=doc.id)
    if crash_at == "after_fence":
        assert posts == f.upstream.posts == 0
        assert result.status == "indexing" and not result.can_delete
    else:
        assert result.status == "ready"
        assert f.upstream.posts == 1
    assert recovered._job_repo.claim(f.other, owner="other", job_id=job.id) is None


def test_unknown_failed_remains_claimable_and_protects_actions_until_processed(recovery_pg):
    f = recovery_pg
    doc, job = f.prepare()
    f.upstream.after_post = lambda: (_ for _ in ()).throw(Crash())
    with pytest.raises(Crash):
        KnowledgeIntakeRecovery(f.service).process(f.ctx, job_id=job.id)
    f.upstream.after_post = None
    f.upstream.hidden = True
    f.due(job.id, attempts=5)
    recovery = KnowledgeIntakeRecovery(f.build())
    recovery.process(f.ctx, job_id=job.id)
    rows = f.client.get(f.path, headers=f.headers).json()["data"]
    row = next(item for item in rows if item["id"] == doc.id)
    assert row["status"] == "failed" and row["error_code"] == "SUBMISSION_UNKNOWN"
    assert not row["can_retry"] and not row["can_delete"]
    for method, path in [("post", f"{f.path}/{doc.id}/retry"), ("delete", f"{f.path}/{doc.id}")]:
        result = getattr(f.client, method)(path, headers=f.headers)
        assert result.status_code == 409 and result.json()["code"] == "knowledge_reconciliation_required"
    f.upstream.hidden = False
    f.upstream.duplicate_source = True
    f.due(job.id)
    recovery.process(f.ctx, job_id=job.id)
    assert f.service._doc_repo.get(f.ctx, document_id=doc.id).status == "failed"
    f.upstream.duplicate_source = False
    f.due(job.id)
    KnowledgeIntakeRecovery(f.build()).process(f.ctx, job_id=job.id)
    assert f.service._doc_repo.get(f.ctx, document_id=doc.id).status == "ready"
    assert f.upstream.posts == 1


def test_legacy_duplicate_document_source_is_protected_before_post_even_not_submitted(recovery_pg):
    f = recovery_pg
    doc, first = f.prepare()
    second = f.service._job_repo.create(
        f.ctx, knowledge_space_id=SPACE, document_id=doc.id, status="parsing",
    )
    with f.router.session(f.ctx) as s:
        s.execute(
            "UPDATE knowledge_ingestion_job SET file_source=%s, submission_state='not_submitted', "
            "lease_until=now()-interval '1 second', next_attempt_at=now()-interval '1 second' "
            "WHERE id IN (%s, %s)",
            (doc.id, first.id, second.id),
        )
    recovery = KnowledgeIntakeRecovery(f.build())
    assert recovery.process(f.ctx, job_id=second.id)
    assert f.upstream.posts == 0
    current = f.service.get_document(f.ctx, knowledge_space_id=SPACE, document_id=doc.id)
    assert current.error_code == "SUBMISSION_UNKNOWN"
    assert not current.can_retry and not current.can_delete


def test_pending_protects_delete_and_reconciles_terminal_failure_then_idempotent_retry(recovery_pg):
    f = recovery_pg
    f.upstream.state = "processing"
    doc, job = f.prepare()
    recovery = KnowledgeIntakeRecovery(f.service)
    recovery.process(f.ctx, job_id=job.id)
    assert f.client.delete(f"{f.path}/{doc.id}", headers=f.headers).status_code == 409
    assert f.client.post(f"{f.path}/{doc.id}/retry", headers=f.headers).status_code == 409
    f.upstream.docs["native-1"]["status"] = "failed"
    f.due(job.id)
    recovery.process(f.ctx, job_id=job.id)
    failed = f.service.get_document(f.ctx, knowledge_space_id=SPACE, document_id=doc.id)
    assert failed.status == "failed" and failed.can_retry and failed.can_delete
    f.upstream.state = "processed"
    headers = {**f.headers, "Idempotency-Key": "retry-fixture"}
    for _ in range(2):
        response = f.client.post(f"{f.path}/{doc.id}/retry", headers=headers)
        assert response.status_code == 201, response.text
        assert response.json()["data"]["status"] == "ready"
    assert f.upstream.posts == 2  # one confirmed terminal failure, one explicit retry
    jobs = f.service._job_repo.list_by_document(f.ctx, document_id=doc.id)
    assert len(jobs) == 2 and jobs[0].file_source != jobs[1].file_source


def test_claim_concurrency_expiry_and_stale_owner_publication(recovery_pg):
    f = recovery_pg
    doc, job = f.prepare()
    barrier = threading.Barrier(2)
    def claim(owner):
        barrier.wait()
        return f.build()._job_repo.claim(f.ctx, owner=owner, job_id=job.id)
    with ThreadPoolExecutor(2) as pool:
        futures = [pool.submit(claim, owner) for owner in ("a", "b")]
        claims = [future.result() for future in futures]
    assert sum(item is not None for item in claims) == 1
    old = next(item for item in claims if item)
    assert f.service._job_repo.claim(f.ctx, owner="third", job_id=job.id) is None
    f.due(job.id)
    new = f.service._job_repo.claim(f.ctx, owner="new", job_id=job.id)
    assert new and new.attempts == 2
    assert not f.service._job_repo.fence_submission(f.ctx, old, owner=old.claim_owner, text_chars=30)
    assert not f.service._job_repo.settle(f.ctx, old, owner=old.claim_owner, state="failed", error_code="OLD_OWNER")
    assert f.service._doc_repo.get(f.ctx, document_id=doc.id).status == "uploaded"
    assert f.service._job_repo.fence_submission(f.ctx, new, owner="new", text_chars=30)
    with pytest.raises(RuntimeError, match="claim expired"):
        f.service._binding_repo.publish_ready(f.ctx, knowledge_space_id=SPACE, document_id=doc.id, employee_ids=[],
            rag_document_id="wrong", job_id=job.id, chunk_count=1, text_chars=30, completed_at=new.heartbeat_at,
            synced_at=new.heartbeat_at, claim_owner=old.claim_owner)
    assert f.service._doc_repo.get(f.ctx, document_id=doc.id).status == "indexing"
    assert f.upstream.posts == 0


def test_atomic_create_rolls_back_document_when_job_insert_fails(recovery_pg, monkeypatch):
    import manager_service.knowledge_intake_repository as module
    f = recovery_pg
    monkeypatch.setattr(module, "_insert_job", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("fixture insert failure")))
    with pytest.raises(RuntimeError):
        f.prepare()
    assert f.service.list_documents(f.ctx, knowledge_space_id=SPACE) == []
    assert f.upstream.posts == 0


def test_parse_failure_before_fence_is_retryable_and_migration_replay_keeps_tracks(recovery_pg):
    f = recovery_pg
    doc, job = f.prepare(content=b"   ")
    KnowledgeIntakeRecovery(f.service).process(f.ctx, job_id=job.id)
    failed = f.service.get_document(f.ctx, knowledge_space_id=SPACE, document_id=doc.id)
    assert failed.status == "failed" and failed.error_code == "EMPTY_TEXT" and failed.can_delete
    assert f.upstream.posts == 0
    doc2, job2 = f.prepare()
    f.upstream.state = "processing"
    KnowledgeIntakeRecovery(f.service).process(f.ctx, job_id=job2.id)
    before = f.service._job_repo.get(f.ctx, ingestion_id=job2.id)
    apply_migrations(f.admin, app_rw_password="apprwpass")
    after = f.service._job_repo.get(f.ctx, ingestion_id=job2.id)
    assert (after.track_id, after.file_source, after.submission_state) == (before.track_id, before.file_source, "submitted")
    assert f.upstream.posts == 1


def test_expired_worker_with_inflight_post_cannot_publish_or_allow_delete(recovery_pg):
    f = recovery_pg
    doc, job = f.prepare()
    f.upstream.state = "processing"
    sent, release = threading.Event(), threading.Event()
    def pause():
        sent.set()
        assert release.wait(5)
    f.upstream.after_post = pause
    with ThreadPoolExecutor(1) as pool:
        first = pool.submit(KnowledgeIntakeRecovery(f.service).process, f.ctx, job_id=job.id)
        assert sent.wait(5)
        assert KnowledgeIntakeRecovery(f.build()).process(f.ctx, job_id=job.id) is False
        assert f.client.delete(f"{f.path}/{doc.id}", headers=f.headers).status_code == 409
        f.due(job.id)
        assert KnowledgeIntakeRecovery(f.build()).process(f.ctx, job_id=job.id)
        assert f.upstream.posts == 1
        release.set()
        first.result()
    current = f.service._job_repo.get(f.ctx, ingestion_id=job.id)
    assert current.track_id is None and current.status == "indexing"
    assert f.service._doc_repo.get(f.ctx, document_id=doc.id).status == "indexing"
    f.upstream.after_post = None
    f.upstream.docs["native-1"]["status"] = "processed"
    f.due(job.id)
    KnowledgeIntakeRecovery(f.build()).process(f.ctx, job_id=job.id)
    assert f.service._doc_repo.get(f.ctx, document_id=doc.id).status == "ready"
    assert f.upstream.posts == 1


def test_pre_submit_validation_failure_has_no_fence_and_can_retry(recovery_pg, monkeypatch):
    from manager_service.rag_ingestion import RagIngestionUnavailable
    f = recovery_pg
    doc, job = f.prepare()
    def unavailable(**kwargs):
        raise RagIngestionUnavailable("fixture configuration unavailable")
    monkeypatch.setattr(f.service._ingestion_client, "validate_submission", unavailable)
    KnowledgeIntakeRecovery(f.service).process(f.ctx, job_id=job.id)
    failed = f.service.get_document(f.ctx, knowledge_space_id=SPACE, document_id=doc.id)
    assert failed.status == "failed" and failed.error_code == "INDEX_UNCONFIGURED"
    assert failed.can_retry and failed.can_delete
    assert f.service._job_repo.get(f.ctx, ingestion_id=job.id).track_id is None
    assert f.upstream.posts == 0


def test_job_scope_fk_and_publication_transaction_rollback(recovery_pg, monkeypatch):
    import psycopg
    from contextlib import contextmanager
    f = recovery_pg
    doc, job = f.prepare()
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        f.service._job_repo.create(f.other, knowledge_space_id=SPACE, document_id=doc.id, status="parsing")
    base = f.service._binding_repo._router
    class BrokenPublicationRouter:
        @contextmanager
        def session(self, ctx):
            with base.session(ctx) as session:
                class Proxy:
                    def execute(self, query, params=None):
                        result = session.execute(query, params)
                        if "UPDATE knowledge_document SET status = 'ready'" in query:
                            raise RuntimeError("fixture after document publication")
                        return result
                yield Proxy()
    monkeypatch.setattr(f.service._binding_repo, "_router", BrokenPublicationRouter())
    KnowledgeIntakeRecovery(f.service).process(f.ctx, job_id=job.id)
    persisted = f.service._job_repo.get(f.ctx, ingestion_id=job.id)
    assert persisted.status == "indexing" and persisted.chunk_count is None and persisted.track_id == "insert_1"
    assert f.service._doc_repo.get(f.ctx, document_id=doc.id).status == "indexing"
    assert f.upstream.posts == 1
    monkeypatch.setattr(f.service._binding_repo, "_router", base)
    f.due(job.id)
    KnowledgeIntakeRecovery(f.build()).process(f.ctx, job_id=job.id)
    assert f.service._doc_repo.get(f.ctx, document_id=doc.id).status == "ready"
    assert f.upstream.posts == 1


def test_rollout_preflight_is_metadata_only_and_read_only(recovery_pg):
    from pathlib import Path
    f = recovery_pg
    doc, job = f.prepare(content=b"BODY MUST NEVER APPEAR IN PREFLIGHT")
    script = Path(__file__).parents[2] / "manager_service" / "knowledge_intake_preflight.sql"
    # tests/manager -> server requires parents[2]
    rows = []
    with f.router.session(f.ctx) as s:
        s.execute("SET TRANSACTION READ ONLY")
        cursor = s.execute(script.read_text())
        while True:
            if cursor.description:
                columns = {item.name for item in cursor.description}
                assert not columns.intersection({"files", "content", "error_message", "storage_key", "file_name", "display_name"})
                rows.extend(cursor.fetchall())
            if not cursor.nextset():
                break
    assert job.id in str(rows)
    assert "BODY MUST NEVER APPEAR" not in str(rows)
    assert f.service._doc_repo.get(f.ctx, document_id=doc.id).status == "uploaded"
    assert f.upstream.posts == 0
