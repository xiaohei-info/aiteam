"""Static Manager-owned LightRAG instance-pool contract tests."""

from __future__ import annotations

import json

import httpx
import pytest

from manager_service.rag_ingestion import LightRagIngestionClient, LightRagIngestionSettings
from manager_service.rag_instances import RagInstance, RagInstanceConfigurationError, RagInstanceRegistry
from manager_service.rag_mcp import LightRagClient, LightRagSettings, RagUnavailable


def _registry(*instances: dict[str, str]) -> RagInstanceRegistry:
    return RagInstanceRegistry(tuple(RagInstance(**item) for item in instances))


def test_registry_routes_each_fixed_workspace_and_redacts_credentials():
    registry = _registry(
        {"instance_id": "rag-a", "url": "http://rag-a", "api_key": "secret-a", "workspace": "space-a"},
        {"instance_id": "rag-b", "url": "https://rag-b/base", "api_key": "secret-b", "workspace": "space-b"},
    )
    assert registry.resolve("space-a").instance_id == "rag-a"
    assert registry.resolve("space-b").url == "https://rag-b/base"
    assert "secret-a" not in repr(registry)
    assert "secret-a" not in repr(LightRagSettings("http://rag", "secret-a"))
    assert "secret-a" not in repr(LightRagIngestionSettings("http://rag", "secret-a", 100, 1000))


def test_registry_fails_closed_for_unknown_or_duplicate_workspace():
    registry = _registry(
        {"instance_id": "rag-a", "url": "http://rag-a", "api_key": "secret-a", "workspace": "space-a"},
    )
    with pytest.raises(RagInstanceConfigurationError):
        registry.resolve("missing")
    with pytest.raises(RagInstanceConfigurationError, match="duplicate LightRAG workspace"):
        _registry(
            {"instance_id": "rag-a", "url": "http://rag-a", "api_key": "secret-a", "workspace": "space-a"},
            {"instance_id": "rag-b", "url": "http://rag-b", "api_key": "secret-b", "workspace": "space-a"},
        )


@pytest.mark.parametrize(
    "raw",
    [
        "{not-json}",
        json.dumps([{"instance_id": "a", "url": "ftp://rag", "api_key": "k", "workspace": "w"}]),
        json.dumps([{"instance_id": "a", "url": "http://rag", "api_key": "k", "workspace": "w\n"}]),
    ],
)
def test_registry_config_bounds_and_protocol_fail_closed(monkeypatch, raw):
    monkeypatch.setenv("LIGHTRAG_INSTANCES", raw)
    with pytest.raises(RagInstanceConfigurationError):
        RagInstanceRegistry.from_env()


def test_query_and_ingestion_select_the_same_instance_and_fixed_workspace():
    registry = _registry(
        {"instance_id": "rag-a", "url": "http://rag-a", "api_key": "secret-a", "workspace": "space-a"},
        {"instance_id": "rag-b", "url": "http://rag-b", "api_key": "secret-b", "workspace": "space-b"},
    )
    query_seen: list[tuple[str, str, str]] = []

    async def query_handler(request: httpx.Request):
        query_seen.append((str(request.url), request.headers["x-api-key"], request.headers["lightrag-workspace"]))
        return httpx.Response(200, json={"status": "success", "data": {"references": []}})

    query = LightRagClient(
        LightRagSettings("unused", "unused", instance_registry=registry),
        transport=httpx.MockTransport(query_handler),
    )
    try:
        import asyncio
        asyncio.run(query.query(workspace="space-b", query="hello", limit=5))
    finally:
        import asyncio
        asyncio.run(query.aclose())
    assert query_seen == [("http://rag-b/query/data", "secret-b", "space-b")]

    ingestion_seen: list[tuple[str, str, str]] = []

    def ingestion_handler(request: httpx.Request):
        ingestion_seen.append((str(request.url), request.headers["x-api-key"], request.headers["lightrag-workspace"]))
        if request.url.path.endswith("/text"):
            return httpx.Response(200, json={"status": "success", "track_id": "track-b"})
        return httpx.Response(200, json={
            "track_id": "track-b", "documents": [{"status": "processed", "file_path": "doc-b", "chunks_count": 1}],
            "total_count": 1,
        })

    settings = LightRagIngestionSettings(
        "unused", "unused", 100, 1000, 1, instance_registry=registry
    )
    ingestion = LightRagIngestionClient(settings, transport=httpx.MockTransport(ingestion_handler))
    try:
        result = ingestion.ingest_text(workspace="space-b", file_source="doc-b", text="hello")
    finally:
        ingestion.close()
    assert result.rag_document_id == "doc-b"
    assert ingestion_seen == [
        ("http://rag-b/documents/text", "secret-b", "space-b"),
        ("http://rag-b/documents/track_status/track-b", "secret-b", "space-b"),
    ]


def test_client_rejects_unknown_workspace_without_upstream_request():
    called = False

    async def handler(request: httpx.Request):
        nonlocal called
        called = True
        return httpx.Response(200, json={"status": "success"})

    registry = _registry({"instance_id": "rag-a", "url": "http://rag-a", "api_key": "secret-a", "workspace": "space-a"})
    client = LightRagClient(
        LightRagSettings("unused", "unused", instance_registry=registry),
        transport=httpx.MockTransport(handler),
    )
    import asyncio
    try:
        with pytest.raises(RagUnavailable):
            asyncio.run(client.query(workspace="space-missing", query="hello", limit=5))
    finally:
        asyncio.run(client.aclose())
    assert not called
