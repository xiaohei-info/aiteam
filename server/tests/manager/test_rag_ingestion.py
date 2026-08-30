"""Manager-owned LightRAG ingestion client contract tests."""

from __future__ import annotations

import json

import httpx
import pytest

from manager_service.rag_ingestion import (
    LightRagIngestionClient,
    LightRagIngestionSettings,
    RagIngestionUnavailable,
    _document_identity,
    _document_info,
)


def _settings(**kwargs):
    values = {"url": "http://rag", "api_key": "manager-secret", "request_timeout_ms": 100,
              "pipeline_timeout_ms": 5, "poll_interval_ms": 1}
    values.update(kwargs)
    return LightRagIngestionSettings(**values)


def test_client_rebinds_explicit_instance_registry():
    from manager_service.rag_instances import RagInstance, RagInstanceRegistry
    registry = RagInstanceRegistry((RagInstance("fixed", "http://rag", "manager-secret", "derived"),))
    client = LightRagIngestionClient(_settings(), instance_registry=registry)
    try:
        assert client.instance_for_workspace("derived").instance_id == "fixed"
    finally:
        client.close()


def test_document_info_projects_bounded_metadata_and_legacy_identity():
    value = _document_info({
        "id": "upstream", "file_path": "source", "status": " PROCESSED ",
        "chunks_count": 3, "content_length": 10,
        "created_at": "2026-08-26T00:00:00Z", "updated_at": None,
    }, workspace="fixed")
    assert value.status == "processed"
    assert value.chunks_count == 3
    assert value.updated_at is None
    assert _document_identity({"id": "upstream", "file_path": "source"}, workspace="fixed") == ("upstream", "source")


@pytest.mark.parametrize("value", [None, [], {"id": "id"}, {"id": "id", "file_path": "source", "workspace": "other"}])
def test_document_info_rejects_invalid_or_cross_workspace_rows(value):
    with pytest.raises(RagIngestionUnavailable):
        _document_info(value, workspace="fixed")


def test_document_info_sanitizes_invalid_optional_values():
    result = _document_info({
        "id": "id", "file_path": "source", "status": "bad\nstatus",
        "chunks_count": -1, "content_length": True,
        "created_at": 42, "updated_at": "x" * 129,
    }, workspace="fixed")
    assert result.status == "unknown"
    assert result.chunks_count is None
    assert result.content_length is None
    assert result.created_at is None
    assert result.updated_at is None


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
    assert result.upstream_document_id == "doc_123456"
    assert "doc_123456" not in repr(result)
    assert seen[0].headers["x-api-key"] == "manager-secret"
    assert seen[0].headers["lightrag-workspace"] == "derived"
    assert json.loads(seen[0].content) == {"text": "hello", "file_source": "doc-1"}
    assert seen[0].url.path == "/documents/text"
    assert seen[1].url.path == "/documents/track_status/insert_20250331_090000_def456"
    assert seen[-1].url.path == "/documents/track_status/insert_20250331_090000_def456"


@pytest.mark.parametrize("payload", [
    {"documents": "bad", "pagination": {}},
    {"documents": [], "pagination": {"page": 2}},
    {"documents": [], "pagination": {"page": 1, "page_size": 0}},
    {"documents": [], "pagination": {"page": 1, "total_count": -1}},
    {"documents": [], "pagination": {"page": 1, "has_next": "yes"}},
    {"documents": [], "pagination": {"page": 1, "total_count": 1, "total_pages": 2}},
    {"documents": [], "pagination": {"page": 1, "total_pages": 1, "has_next": True}},
    {"documents": [], "pagination": {"page": 1, "total_count": 201, "has_next": False}},
])
def test_document_listing_rejects_ambiguous_pagination(payload):
    client = LightRagIngestionClient(
        _settings(), transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload)),
    )
    try:
        with pytest.raises(RagIngestionUnavailable, match="knowledge analytics unavailable"):
            client.list_documents(workspace="derived")
    finally:
        client.close()


def test_document_listing_converts_transport_errors_to_unavailable():
    def handler(request: httpx.Request):
        raise RuntimeError("transport down")
    client = LightRagIngestionClient(_settings(), transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(RagIngestionUnavailable, match="knowledge analytics unavailable"):
            client.list_documents(workspace="derived")
    finally:
        client.close()


def test_document_listing_rejects_upstream_http_error():
    client = LightRagIngestionClient(
        _settings(), transport=httpx.MockTransport(lambda request: httpx.Response(503)),
    )
    try:
        with pytest.raises(RagIngestionUnavailable, match="knowledge analytics unavailable"):
            client.list_documents(workspace="derived")
    finally:
        client.close()


def test_document_listing_rejects_empty_workspace():
    client = LightRagIngestionClient(_settings())
    try:
        with pytest.raises(RagIngestionUnavailable):
            client.list_documents(workspace=" ")
    finally:
        client.close()


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


def test_ingestion_rejects_missing_or_ambiguous_upstream_document_id():
    responses = [
        {
            "track_id": "track-1", "documents": [{"file_path": "doc-1", "status": "processed"}],
            "total_count": 1,
        },
        {
            "track_id": "track-1", "documents": [
                {"id": "doc-a", "file_path": "doc-1", "status": "processed"},
                {"id": "doc-b", "file_path": "doc-1", "status": "processed"},
            ], "total_count": 2,
        },
    ]

    def handler(request: httpx.Request):
        if request.url.path.endswith("/text"):
            return httpx.Response(200, json={"status": "success", "track_id": "track-1"})
        return httpx.Response(200, json=responses.pop(0))

    client = LightRagIngestionClient(_settings(), transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(RagIngestionUnavailable):
            client.ingest_text(workspace="derived", file_source="doc-1", text="hello")
        with pytest.raises(RagIngestionUnavailable):
            client.ingest_text(workspace="derived", file_source="doc-1", text="hello")
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
                "id": "upstream-doc-1", "status": status, "file_path": "doc-1", "chunks_count": 1,
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


def test_document_probe_accepts_only_resolved_internal_id():
    client = LightRagIngestionClient(
        _settings(),
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={
            "documents": [{"id": "opaque-id", "file_path": "doc-1"}],
            "pagination": {"page": 1, "page_size": 200, "total_count": 1, "total_pages": 1},
        })),
    )
    try:
        assert client.document_ids_present(
            workspace="derived", doc_ids=["opaque-id", "missing"]
        ) == {"opaque-id"}
        assert client.document_ids_present(
            workspace="derived", doc_ids=["doc-1"]
        ) == set()
    finally:
        client.close()


def test_alias_resolver_maps_legacy_file_source_to_upstream_id():
    client = LightRagIngestionClient(
        _settings(),
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={
            "documents": [{"id": "doc-internal-1", "file_path": "manager-uuid-1"}],
            "pagination": {"page": 1, "page_size": 200, "total_count": 1, "total_pages": 1},
        })),
    )
    try:
        assert client.resolve_document_id(
            workspace="derived", aliases=["manager-uuid-1"]
        ) == "doc-internal-1"
    finally:
        client.close()


def test_alias_resolver_rejects_ambiguous_malformed_and_cross_space_rows():
    responses = [
        {
            "documents": [
                {"id": "doc-a", "file_path": "manager-uuid"},
                {"id": "doc-b", "file_path": "manager-uuid"},
            ],
            "pagination": {"page": 1, "page_size": 200, "total_count": 2, "total_pages": 1},
        },
        {
            "documents": [{"id": "doc-a"}],
            "pagination": {"page": 1, "page_size": 200, "total_count": 1, "total_pages": 1},
        },
        {
            "documents": [{"id": "doc-a", "file_path": "manager-uuid", "workspace": "other"}],
            "pagination": {"page": 1, "page_size": 200, "total_count": 1, "total_pages": 1},
        },
    ]

    def handler(request: httpx.Request):
        return httpx.Response(200, json=responses.pop(0))

    client = LightRagIngestionClient(_settings(), transport=httpx.MockTransport(handler))
    try:
        for _ in range(3):
            with pytest.raises(RagIngestionUnavailable):
                client.resolve_document_id(workspace="derived", aliases=["manager-uuid"])
    finally:
        client.close()


def test_delete_body_uses_resolved_upstream_id():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request):
        seen.append(request)
        if request.url.path.endswith("/paginated"):
            return httpx.Response(200, json={
                "documents": [{"id": "doc-internal-1", "file_path": "manager-uuid-1"}],
                "pagination": {"page": 1, "page_size": 200, "total_count": 1, "total_pages": 1},
            })
        return httpx.Response(200, json={"status": "deletion_started"})

    client = LightRagIngestionClient(_settings(), transport=httpx.MockTransport(handler))
    try:
        upstream_id = client.resolve_document_id(
            workspace="derived", aliases=["manager-uuid-1"]
        )
        assert upstream_id == "doc-internal-1"
        client.delete_document(workspace="derived", doc_ids=[upstream_id])
    finally:
        client.close()
    assert seen[-1].url.path == "/documents/delete_document"
    assert json.loads(seen[-1].content) == {
        "doc_ids": ["doc-internal-1"],
        "delete_file": False,
        "delete_llm_cache": True,
    }


def test_alias_resolver_rejects_unbounded_pagination():
    client = LightRagIngestionClient(
        _settings(),
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={
            "documents": [],
            "pagination": {"page": 1, "page_size": 200, "total_count": 6_401, "total_pages": 33},
        })),
    )
    try:
        with pytest.raises(RagIngestionUnavailable):
            client.resolve_document_id(workspace="derived", aliases=["manager-uuid"])
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
