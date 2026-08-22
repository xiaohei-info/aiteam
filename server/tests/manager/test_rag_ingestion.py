"""Manager-owned LightRAG ingestion client contract tests."""

from __future__ import annotations

import json

import httpx
import pytest

from manager_service.rag_ingestion import (
    LightRagIngestionClient,
    LightRagIngestionSettings,
    RagIngestionUnavailable,
)


def _settings(**kwargs):
    values = {"url": "http://rag", "api_key": "manager-secret", "request_timeout_ms": 100,
              "pipeline_timeout_ms": 5, "poll_interval_ms": 1}
    values.update(kwargs)
    return LightRagIngestionSettings(**values)


def test_ingestion_posts_manager_headers_and_waits_for_ready():
    seen: list[httpx.Request] = []
    responses = [
        # LightRAG 1.5.6 /documents/text response fixture.
        httpx.Response(200, json={
            "status": "success", "message": "Processing started",
            "track_id": "insert_20250331_090000_def456",
        }),
        # LightRAG 1.5.6 /documents/track_status/{track_id} fixture.
        httpx.Response(200, json={
            "track_id": "insert_20250331_090000_def456", "documents": [],
            "total_count": 0, "status_summary": {},
        }),
        httpx.Response(200, json={
            "track_id": "insert_20250331_090000_def456",
            "documents": [{
                "id": "doc_123456", "content_summary": "hello",
                "content_length": 5, "status": "processed",
                "created_at": "2025-03-31T09:00:00",
                "updated_at": "2025-03-31T09:05:00",
                "track_id": "insert_20250331_090000_def456", "chunks_count": 1,
                "error_msg": None, "metadata": None, "file_path": "doc-1",
            }],
            "total_count": 1, "status_summary": {"processed": 1},
        }),
    ]

    def handler(request: httpx.Request):
        seen.append(request)
        return responses.pop(0)

    client = LightRagIngestionClient(_settings(), transport=httpx.MockTransport(handler), sleeper=lambda _: None)
    try:
        result = client.ingest_text(workspace="derived", file_source="doc-1", text="hello")
    finally:
        client.close()
    assert result.rag_document_id == "doc-1"
    assert seen[0].headers["x-api-key"] == "manager-secret"
    assert seen[0].headers["lightrag-workspace"] == "derived"
    assert json.loads(seen[0].content) == {"text": "hello", "file_source": "doc-1"}
    assert seen[0].url.path == "/documents/text"
    assert seen[1].url.path == "/documents/track_status/insert_20250331_090000_def456"
    assert seen[-1].url.path == "/documents/track_status/insert_20250331_090000_def456"


def test_ingestion_fails_on_missing_config(monkeypatch: pytest.MonkeyPatch):
    for name in ("LIGHTRAG_URL", "LIGHTRAG_API_KEY", "LIGHTRAG_PIPELINE_TIMEOUT_MS"):
        monkeypatch.delenv(name, raising=False)
    client = LightRagIngestionClient(None)
    try:
        with pytest.raises(RagIngestionUnavailable):
            client.ingest_text(workspace="derived", file_source="doc-1", text="hello")
    finally:
        client.close()


def test_ingestion_rejects_workspace_not_owned_by_fixed_instance():
    client = LightRagIngestionClient(
        _settings(workspace="fixed-workspace"),
        transport=httpx.MockTransport(lambda request: httpx.Response(500)),
    )
    try:
        with pytest.raises(RagIngestionUnavailable, match="knowledge indexing unavailable"):
            client.ingest_text(workspace="other-workspace", file_source="doc-1", text="hello")
    finally:
        client.close()


def test_deletion_uses_exact_lightrag_156_endpoint_and_bounded_body():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request):
        seen.append(request)
        return httpx.Response(200, json={"deletion_started": True, "busy": False})

    client = LightRagIngestionClient(_settings(), transport=httpx.MockTransport(handler))
    try:
        result = client.delete_document(
            workspace="derived", doc_ids=["rag-doc-1"],
            delete_file=False, delete_llm_cache=True,
        )
    finally:
        client.close()
    assert result.deletion_started is True
    assert result.busy is False
    assert seen[0].method == "DELETE"
    assert seen[0].url.path == "/documents/delete_document"
    assert json.loads(seen[0].content) == {
        "doc_ids": ["rag-doc-1"],
        "delete_file": False,
        "delete_llm_cache": True,
    }


def test_deletion_accepts_single_explicit_started_flag():
    client = LightRagIngestionClient(
        _settings(),
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"deletion_started": True})
        ),
    )
    try:
        result = client.delete_document(workspace="derived", doc_ids=["rag-doc-1"])
    finally:
        client.close()
    assert result == type(result)(deletion_started=True, busy=False)


def test_deletion_accepts_lightrag_156_status_acknowledgement():
    client = LightRagIngestionClient(
        _settings(),
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={
                "status": "deletion_started",
                "message": "Document deletion has been initiated.",
                "doc_id": "rag-doc-1",
            })
        ),
    )
    try:
        result = client.delete_document(workspace="derived", doc_ids=["rag-doc-1"])
    finally:
        client.close()
    assert result == type(result)(deletion_started=True, busy=False)


def test_deletion_accepts_explicit_busy_status():
    client = LightRagIngestionClient(
        _settings(),
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"status": "busy"})
        ),
    )
    try:
        result = client.delete_document(workspace="derived", doc_ids=["rag-doc-1"])
    finally:
        client.close()
    assert result == type(result)(deletion_started=False, busy=True)


def test_deletion_rejects_ambiguous_response_without_claiming_success():
    client = LightRagIngestionClient(
        _settings(),
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"status": "success"})),
    )
    try:
        with pytest.raises(RagIngestionUnavailable):
            client.delete_document(workspace="derived", doc_ids=["rag-doc-1"])
    finally:
        client.close()


def test_ingestion_fails_on_upstream_error_without_details():
    def handler(request: httpx.Request):
        return httpx.Response(502, text="provider token manager-secret")

    client = LightRagIngestionClient(_settings(), transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(RagIngestionUnavailable, match="knowledge indexing unavailable") as exc:
            client.ingest_text(workspace="derived", file_source="doc-1", text="hello")
        assert "manager-secret" not in str(exc.value)
    finally:
        client.close()


def test_ingestion_pipeline_timeout_is_bounded():
    clock = [0.0]

    def handler(request: httpx.Request):
        return httpx.Response(
            200,
            json=(
                {"status": "success", "track_id": "track-1"}
                if request.url.path.endswith("/text")
                else {"track_id": "track-1", "documents": [], "total_count": 0, "status_summary": {}}
            ),
        )

    def sleep(seconds: float):
        clock[0] += seconds

    client = LightRagIngestionClient(
        _settings(pipeline_timeout_ms=2, poll_interval_ms=1),
        transport=httpx.MockTransport(handler), sleeper=sleep, clock=lambda: clock[0],
    )
    try:
        with pytest.raises(RagIngestionUnavailable):
            client.ingest_text(workspace="derived", file_source="doc-1", text="hello")
    finally:
        client.close()
    assert clock[0] >= 0.002


@pytest.mark.parametrize("status", ["PROCESSED", "processed"])
def test_ingestion_accepts_only_case_insensitive_processed_status(status):
    def handler(request: httpx.Request):
        if request.url.path.endswith("/text"):
            return httpx.Response(200, json={"status": "success", "track_id": "track-1"})
        return httpx.Response(200, json={
            "track_id": "track-1", "documents": [{
                "status": status, "file_path": "doc-1", "chunks_count": 1,
            }], "total_count": 1,
        })

    client = LightRagIngestionClient(_settings(), transport=httpx.MockTransport(handler))
    try:
        assert client.ingest_text(workspace="derived", file_source="doc-1", text="hello").chunk_count == 1
    finally:
        client.close()


def test_ingestion_rejects_generic_ready_status():
    def handler(request: httpx.Request):
        if request.url.path.endswith("/text"):
            return httpx.Response(200, json={"status": "success", "track_id": "track-1"})
        return httpx.Response(200, json={
            "track_id": "track-1", "documents": [{
                "status": "ready", "file_path": "doc-1", "chunks_count": 1,
            }], "total_count": 1,
        })

    client = LightRagIngestionClient(_settings(), transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(RagIngestionUnavailable):
            client.ingest_text(workspace="derived", file_source="doc-1", text="hello")
    finally:
        client.close()


def test_ingestion_rejects_terminal_status_for_wrong_file_source():
    def handler(request: httpx.Request):
        if request.url.path.endswith("/text"):
            return httpx.Response(200, json={"status": "success", "track_id": "track-1"})
        return httpx.Response(200, json={
            "track_id": "track-1", "documents": [{
                "id": "other", "status": "processed", "file_path": "other-source",
                "chunks_count": 1,
            }], "total_count": 1, "status_summary": {"processed": 1},
        })

    client = LightRagIngestionClient(_settings(), transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(RagIngestionUnavailable):
            client.ingest_text(workspace="derived", file_source="doc-1", text="hello")
    finally:
        client.close()


def test_ingestion_rejects_bad_pipeline_response():
    def handler(request: httpx.Request):
        return httpx.Response(
            200,
            json=(
                {"status": "success", "track_id": "track-1"}
                if request.url.path.endswith("/text")
                else {"track_id": "track-1", "documents": "bad", "total_count": 1}
            ),
        )

    client = LightRagIngestionClient(_settings(), transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(RagIngestionUnavailable):
            client.ingest_text(workspace="derived", file_source="doc-1", text="hello")
    finally:
        client.close()


def test_document_probe_reports_absent_ids_without_returning_upstream_fields():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request):
        seen.append(request)
        return httpx.Response(200, json={
            "documents": [{"id": "other", "file_path": "other-source", "content": "secret"}],
            "pagination": {"page": 1, "page_size": 200, "total_count": 1, "total_pages": 1},
        })

    client = LightRagIngestionClient(_settings(), transport=httpx.MockTransport(handler))
    try:
        assert client.document_ids_present(workspace="derived", doc_ids=["doc-1"]) == set()
    finally:
        client.close()
    assert seen[0].url.path == "/documents/paginated"
    assert json.loads(seen[0].content) == {
        "page": 1, "page_size": 200, "sort_field": "created_at", "sort_direction": "desc",
    }


def test_document_probe_matches_id_or_file_path():
    client = LightRagIngestionClient(
        _settings(),
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={
            "documents": [{"id": "opaque-id", "file_path": "doc-1"}],
            "pagination": {"page": 1, "page_size": 200, "total_count": 1, "total_pages": 1},
        })),
    )
    try:
        assert client.document_ids_present(
            workspace="derived", doc_ids=["doc-1", "missing"]
        ) == {"doc-1"}
    finally:
        client.close()


def test_document_probe_rejects_malformed_document_or_pagination():
    responses = [
        {"documents": [{"status": "processed"}], "pagination": {"page": 1, "total_pages": 1}},
        {"documents": [], "pagination": {"page": 1, "page_size": 200, "total_pages": 33}},
    ]

    def handler(request: httpx.Request):
        return httpx.Response(200, json=responses.pop(0))

    client = LightRagIngestionClient(_settings(), transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(RagIngestionUnavailable):
            client.document_ids_present(workspace="derived", doc_ids=["doc-1"])
        with pytest.raises(RagIngestionUnavailable):
            client.document_ids_present(workspace="derived", doc_ids=["doc-1"])
    finally:
        client.close()


def test_document_probe_walks_bounded_pagination():
    seen_pages: list[int] = []

    def handler(request: httpx.Request):
        body = json.loads(request.content)
        seen_pages.append(body["page"])
        page = body["page"]
        return httpx.Response(200, json={
            "documents": ([{"id": "doc-1", "file_path": "doc-1"}] if page == 2 else []),
            "pagination": {"page": page, "page_size": 200, "total_count": 201, "total_pages": 2},
        })

    client = LightRagIngestionClient(_settings(), transport=httpx.MockTransport(handler))
    try:
        assert client.document_ids_present(workspace="derived", doc_ids=["doc-1"]) == {"doc-1"}
    finally:
        client.close()
    assert seen_pages == [1, 2]
