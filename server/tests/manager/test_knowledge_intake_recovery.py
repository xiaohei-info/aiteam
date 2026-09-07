"""S05 bounded fake-HTTP protocol and in-memory repository contract regressions."""
import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock

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
