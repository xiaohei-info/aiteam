"""S05 bounded fake-HTTP protocol and in-memory repository contract regressions."""
import asyncio
import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

import httpx
import pytest

from manager_service.knowledge_intake_recovery import KnowledgeIntakeRecovery
from manager_service.rag_ingestion import LightRagIngestionClient, LightRagIngestionSettings, RagIngestionUnavailable
from shared.contracts.tenancy import TenantContext
from tests.manager.test_knowledge_intake_unit import _make_service, _owner_ctx


def client(handler):
    return LightRagIngestionClient(LightRagIngestionSettings("https://fixture.invalid", "synthetic", 1000, 2000), transport=httpx.MockTransport(handler))


def document(source="source/job", *, status="processed", id="native-1", **extra):
    return {"id": id, "file_path": source, "status": status, "chunks_count": 2, **extra}


def test_recovery_claims_under_request_tenant_context():
    repo = Mock()
    repo.claim.return_value = None
    intake = SimpleNamespace(_job_repo=repo)
    recovery = KnowledgeIntakeRecovery(intake)
    ctx = TenantContext(tenant_id="tenant-a", user_id="recovery", roles=[])
    assert recovery.process(ctx) is False
    repo.claim.assert_called_once()


def test_recovery_worker_rotates_bounded_inventory_and_isolates_tenant_failure():
    recovery = KnowledgeIntakeRecovery(SimpleNamespace())
    tenant_ids = [f"tenant-{index:02d}" for index in range(40)]
    inventory_calls = []
    processed = []

    def inventory(_admin_dsn, *, after_tenant_id=None, limit=32):
        inventory_calls.append(after_tenant_id)
        start = 0 if after_tenant_id is None else tenant_ids.index(after_tenant_id) + 1
        return tenant_ids[start:start + limit]

    def maintain(ctx, *, limit):
        assert limit == 1
        processed.append(ctx.tenant_id)
        if ctx.tenant_id in {tenant_ids[0], tenant_ids[10]}:
            raise RuntimeError("fixture tenant failure")
        return 1

    recovery.due_tenant_ids = Mock(side_effect=inventory)
    recovery.maintain_once = maintain

    # A failed tenant consumes its bounded pass slot; later tenants still run.
    assert recovery.maintain_all("admin-fixture", limit=8) == 7
    assert processed == tenant_ids[:8]
    # The cursor reaches tenants beyond the first 32-row inventory instead of
    # repeatedly starving them on every sweep, even with persistent due rows.
    assert recovery.maintain_all("admin-fixture", limit=8) == 7
    assert recovery.maintain_all("admin-fixture", limit=8) == 8
    assert recovery.maintain_all("admin-fixture", limit=8) == 8
    assert recovery.maintain_all("admin-fixture", limit=8) == 8
    assert processed == tenant_ids
    # Once the cursor reaches the end, the bounded inventory wraps.  The
    # failing first tenant does not prevent the rest of that pass.
    assert recovery.maintain_all("admin-fixture", limit=8) == 7
    assert processed[-8:] == tenant_ids[:8]
    assert inventory_calls == [
        None, tenant_ids[7], tenant_ids[15], tenant_ids[23], tenant_ids[31],
        tenant_ids[39], None,
    ]


def test_recovery_cursor_survives_disappearing_tenant_and_reaches_new_due_tenant():
    recovery = KnowledgeIntakeRecovery(SimpleNamespace())
    live = [f"tenant-{index:02d}" for index in range(8)]
    processed = []

    def inventory(_admin_dsn, *, after_tenant_id=None, limit=32):
        ordered = sorted(live)
        if after_tenant_id is not None:
            ordered = [tenant for tenant in ordered if tenant > after_tenant_id]
        return ordered[:limit]

    recovery.due_tenant_ids = inventory
    recovery.maintain_once = lambda ctx, *, limit: processed.append(ctx.tenant_id) or 1
    assert recovery.maintain_all("admin-fixture", limit=8) == 8
    live.remove("tenant-07")
    live.append("tenant-08")
    assert recovery.maintain_all("admin-fixture", limit=8) == 1
    assert processed == [f"tenant-{index:02d}" for index in range(9)]


def test_recovery_inventory_failure_does_not_advance_instance_cursor():
    recovery = KnowledgeIntakeRecovery(SimpleNamespace())
    recovery.due_tenant_ids = Mock(side_effect=[RuntimeError("fixture inventory"), ["tenant-a"]])
    with pytest.raises(RuntimeError, match="fixture inventory"):
        recovery.maintain_all("admin-fixture")
    assert recovery._tenant_cursor is None
    recovery.maintain_once = lambda ctx, *, limit: 1
    assert recovery.maintain_all("admin-fixture") == 1


def test_recovery_worker_does_not_swallow_cancellation():
    recovery = KnowledgeIntakeRecovery(SimpleNamespace())
    recovery.due_tenant_ids = lambda _admin_dsn: ["tenant-a"]

    def cancelled(_ctx, *, limit):
        raise asyncio.CancelledError()

    recovery.maintain_once = cancelled
    with pytest.raises(asyncio.CancelledError):
        recovery.maintain_all("admin-fixture")


def test_recovery_restart_reset_uses_current_due_rows_without_starvation():
    due = [f"tenant-{index:02d}" for index in range(24)]
    processed = []

    def inventory(_admin_dsn, *, after_tenant_id=None, limit=32):
        ordered = sorted(due)
        if after_tenant_id is not None:
            ordered = [tenant for tenant in ordered if tenant > after_tenant_id]
        return ordered[:limit]

    def maintain(ctx, *, limit):
        processed.append(ctx.tenant_id)
        due.remove(ctx.tenant_id)
        return 1

    first = KnowledgeIntakeRecovery(SimpleNamespace())
    first.due_tenant_ids = inventory
    first.maintain_once = maintain
    assert first.maintain_all("admin-fixture") == 8

    # A restarted worker has a fresh instance-local cursor, but the durable
    # claim/backoff state means already-attempted rows are no longer in the
    # current due inventory.
    restarted = KnowledgeIntakeRecovery(SimpleNamespace())
    restarted.due_tenant_ids = inventory
    restarted.maintain_once = maintain
    assert restarted.maintain_all("admin-fixture") == 8
    assert processed == [f"tenant-{index:02d}" for index in range(16)]


def test_due_inventory_is_bounded_and_cursor_scoped_to_admin_metadata():
    connection = MagicMock()
    connection.__enter__.return_value = connection
    connection.__exit__.return_value = None
    connection.execute.return_value.fetchall.return_value = [("tenant-a",)]
    with patch("psycopg.connect", return_value=connection):
        assert KnowledgeIntakeRecovery.due_tenant_ids("admin-fixture", limit=999) == ["tenant-a"]
        assert KnowledgeIntakeRecovery.due_tenant_ids(
            "admin-fixture", after_tenant_id="tenant-a", limit=999,
        ) == ["tenant-a"]

    first, second = connection.execute.call_args_list
    assert first.args[1] == (64,)
    assert second.args[1] == ("tenant-a", 64)
    assert "tenant_id > %s::uuid" in second.args[0]


def test_submission_uses_only_supported_text_fields_without_workspace_pin():
    seen = []
    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"status": "success", "track_id": "insert_fixture"})
    adapter = client(handler)
    assert adapter.submit_text(workspace="enterprise", file_source="source/job", text="fixture") == "insert_fixture"
    assert json.loads(seen[0].content) == {"text": "fixture", "file_source": "source/job"}
    adapter.validate_submission(workspace="other", file_source="source/job", text="fixture")
    assert len(seen) == 1
    adapter.close()


@pytest.mark.parametrize("payload", [
    {"track_id": "other", "documents": [document()], "total_count": 1},
    {"track_id": "insert_fixture", "documents": [document("wrong-source")], "total_count": 1},
    {"track_id": "insert_fixture", "documents": [document()], "total_count": True},
    {"track_id": "insert_fixture", "documents": [document(), document()], "total_count": 2},
    {"track_id": "insert_fixture", "documents": [document(workspace="other")], "total_count": 1},
])
def test_track_identity_ambiguity_never_publishes_or_resubmits(payload):
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=payload)
    adapter = client(handler)
    with pytest.raises(RagIngestionUnavailable):
        adapter.reconcile_ingestion(workspace="enterprise", file_source="source/job", track_id="insert_fixture")
    assert all(request.method == "GET" for request in requests)
    adapter.close()


@pytest.mark.parametrize("late_conflict", [False, True])
def test_full_bounded_pagination_before_claiming_lost_track_source(late_conflict):
    pages = []
    def handler(request):
        assert request.url.path == "/documents/paginated"
        page = json.loads(request.content)["page"]
        pages.append(page)
        docs = [document() if page == 1 or late_conflict else document("unrelated", id="other")]
        return httpx.Response(200, json={"documents": docs, "pagination": {"page": page, "page_size": 1, "total_count": 2, "total_pages": 2, "has_next": page < 2}})
    adapter = client(handler)
    state = adapter.reconcile_ingestion(workspace="enterprise", file_source="source/job")
    assert state.state == ("unknown" if late_conflict else "processed")
    assert pages == [1, 2]
    adapter.close()


@pytest.mark.parametrize("original_state, expected", [("processing", "unknown"), ("failed", "unknown"), ("processed", "processed")])
def test_duplicate_marker_requires_processed_original_in_same_workspace(original_state, expected):
    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={"track_id": "insert_fixture", "documents": [document(status="failed", metadata={"is_duplicate": True, "original_doc_id": "original"})], "total_count": 1})
        return httpx.Response(200, json={"documents": [document("older-source", status=original_state, id="original")], "pagination": {"has_next": False}})
    adapter = client(handler)
    assert adapter.reconcile_ingestion(workspace="enterprise", file_source="source/job", track_id="insert_fixture").state == expected
    adapter.close()


def test_track_response_is_bounded_during_read():
    adapter = client(lambda _: httpx.Response(200, content=b"x" * (512 * 1024 + 1)))
    with pytest.raises(RagIngestionUnavailable):
        adapter.reconcile_ingestion(workspace="enterprise", file_source="source/job", track_id="insert_fixture")
    adapter.close()


@pytest.mark.asyncio
async def test_recovery_lifespan_starts_and_restarts_bounded_worker(monkeypatch):
    from fastapi import FastAPI
    from manager_service.knowledge_intake_recovery import install_knowledge_intake_lifespan

    app = FastAPI()
    service = SimpleNamespace()
    app.state.settings = SimpleNamespace(admin_db_url="admin-fixture")
    app.state._knowledge_intake_service = service
    loop = asyncio.get_running_loop()
    events = [asyncio.Event(), asyncio.Event()]
    workers = []

    def maintain(self, admin_dsn):
        assert admin_dsn == "admin-fixture"
        workers.append(self)
        loop.call_soon_threadsafe(events[min(len(workers) - 1, len(events) - 1)].set)

    monkeypatch.setattr(KnowledgeIntakeRecovery, "maintain_all", maintain)
    install_knowledge_intake_lifespan(app)
    async with app.router.lifespan_context(app):
        await asyncio.wait_for(events[0].wait(), timeout=2)
    async with app.router.lifespan_context(app):
        await asyncio.wait_for(events[1].wait(), timeout=2)

    assert workers[0].intake is service and workers[-1].intake is service
    assert workers[0] is not workers[-1]


def test_inmemory_fake_atomic_create_and_claim_match_pg_contract(tmp_path, monkeypatch):
    svc = _make_service(space_root=tmp_path, existing_spaces={"ks"})
    ctx = _owner_ctx()
    create = svc._job_repo.create
    monkeypatch.setattr(svc._job_repo, "create", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("failure")))
    with pytest.raises(RuntimeError):
        svc.prepare_upload(ctx, knowledge_space_id="ks", display_name="test", file_name="test.txt", file_type="text/plain", content=b"fixture")
    assert svc._doc_repo.list_by_space(ctx, knowledge_space_id="ks") == []
    monkeypatch.setattr(svc._job_repo, "create", create)
    doc, job = svc.prepare_upload(ctx, knowledge_space_id="ks", display_name="test", file_name="test.txt", file_type="text/plain", content=b"fixture")
    first = svc._job_repo.claim(ctx, owner="first", job_id=job.id)
    assert first and svc._job_repo.claim(ctx, owner="second", job_id=job.id) is None
    svc._job_repo._by_id[job.id] = replace(first, lease_until=datetime.now(timezone.utc)-timedelta(seconds=1))
    second = svc._job_repo.claim(ctx, owner="second", job_id=job.id)
    assert second and second.attempts == 2
    assert not svc._job_repo.fence_submission(ctx, first, owner="first", text_chars=7)
    assert svc._job_repo.fence_submission(ctx, second, owner="second", text_chars=7)
    with pytest.raises(RuntimeError):
        svc._binding_repo.publish_ready(ctx, knowledge_space_id="ks", document_id=doc.id, employee_ids=[], rag_document_id=doc.id,
            job_id=job.id, chunk_count=1, text_chars=7, completed_at=datetime.now(timezone.utc), synced_at=datetime.now(timezone.utc), claim_owner="first")
    assert svc._doc_repo.get(ctx, document_id=doc.id).status == "indexing"
