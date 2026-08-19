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
