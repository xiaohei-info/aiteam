"""Static Manager-owned LightRAG instance-pool contract tests."""

from __future__ import annotations

import json

import httpx
import pytest

from manager_service.rag_ingestion import LightRagIngestionClient, LightRagIngestionSettings
from manager_service.rag_instances import RagInstance, RagInstanceConfigurationError, RagInstanceRegistry
from manager_service.rag_mcp import LightRagClient, LightRagSettings


def _registry(*instances: dict[str, str]) -> RagInstanceRegistry:
    return RagInstanceRegistry(tuple(
        RagInstance(item["instance_id"], item["url"], item["api_key"])
        for item in instances
    ))


def test_registry_routes_any_valid_workspace_and_redacts_credentials():
    registry = _registry(
        {"instance_id": "rag-a", "url": "http://rag-a", "api_key": "secret-a"},
        {"instance_id": "rag-b", "url": "https://rag-b/base", "api_key": "secret-b"},
    )
    first = registry.resolve("tenant-a__enterprise_shared")
    assert first.instance_id in {"rag-a", "rag-b"}
    assert registry.resolve("tenant-a__enterprise_shared") == first
    assert "secret-a" not in repr(registry)
    assert "secret-a" not in repr(LightRagSettings("http://rag", "secret-a"))
    assert "secret-a" not in repr(LightRagIngestionSettings("http://rag", "secret-a", 100, 1000))


def test_registry_fails_closed_for_invalid_workspace_or_duplicate_instance():
    registry = _registry(
        {"instance_id": "rag-a", "url": "http://rag-a", "api_key": "secret-a"},
    )
    with pytest.raises(RagInstanceConfigurationError):
        registry.resolve(" ")
    with pytest.raises(RagInstanceConfigurationError, match="duplicate LightRAG instance_id"):
        _registry(
            {"instance_id": "rag-a", "url": "http://rag-a", "api_key": "secret-a"},
            {"instance_id": "rag-a", "url": "http://rag-b", "api_key": "secret-b"},
        )


@pytest.mark.parametrize(
    "raw",
    [
        "{not-json}",
        json.dumps([{"instance_id": "a", "url": "ftp://rag", "api_key": "k"}]),
        json.dumps([{"instance_id": "a", "url": "http://rag", "api_key": "k\n"}]),
        json.dumps([{"instance_id": "a", "url": "http://rag", "workspace": "w"}]),
    ],
)
def test_registry_config_bounds_and_protocol_fail_closed(monkeypatch, raw):
    monkeypatch.setenv("LIGHTRAG_INSTANCES", raw)
    with pytest.raises(RagInstanceConfigurationError):
        RagInstanceRegistry.from_env()


def test_registry_discards_legacy_workspace_configuration(monkeypatch):
    monkeypatch.setenv("LIGHTRAG_INSTANCES", json.dumps([
        {"instance_id": "rag-a", "url": "http://rag-a", "api_key": "secret-a", "workspace": "old-fixed"},
    ]))
    registry = RagInstanceRegistry.from_env()
    assert registry is not None
    assert not hasattr(registry.instances[0], "workspace")
    assert registry.resolve("tenant-b__enterprise_shared").instance_id == "rag-a"


def test_legacy_env_workspace_is_ignored(monkeypatch):
    monkeypatch.delenv("LIGHTRAG_INSTANCES", raising=False)
    monkeypatch.setenv("LIGHTRAG_URL", "http://rag")
    monkeypatch.setenv("LIGHTRAG_API_KEY", "secret")
    monkeypatch.setenv("LIGHTRAG_WORKSPACE", "old-fixed")
    registry = RagInstanceRegistry.from_env()
    assert registry is not None
    assert not hasattr(registry.instances[0], "workspace")


def test_query_and_ingestion_select_the_same_instance_for_requested_workspace():
    registry = _registry(
        {"instance_id": "rag-a", "url": "http://rag-a", "api_key": "secret-a"},
        {"instance_id": "rag-b", "url": "http://rag-b", "api_key": "secret-b"},
    )
    selected = registry.resolve("space-b")
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
    assert query_seen == [(f"{selected.url}/query/data", selected.api_key, "space-b")]

    ingestion_seen: list[tuple[str, str, str]] = []

    def ingestion_handler(request: httpx.Request):
        ingestion_seen.append((str(request.url), request.headers["x-api-key"], request.headers["lightrag-workspace"]))
        if request.url.path.endswith("/text"):
            return httpx.Response(200, json={"status": "success", "track_id": "track-b"})
        return httpx.Response(200, json={
            "track_id": "track-b", "documents": [{"id": "doc-internal-b", "status": "processed", "file_path": "doc-b", "chunks_count": 1}],
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
        (f"{selected.url}/documents/text", selected.api_key, "space-b"),
        (f"{selected.url}/documents/track_status/track-b", selected.api_key, "space-b"),
    ]


def test_client_routes_workspace_without_static_allowlist():
    seen: list[str] = []

    async def handler(request: httpx.Request):
        seen.append(request.headers["lightrag-workspace"])
        return httpx.Response(200, json={"status": "success"})

    registry = _registry({"instance_id": "rag-a", "url": "http://rag-a", "api_key": "secret-a"})
    client = LightRagClient(
        LightRagSettings("unused", "unused", instance_registry=registry),
        transport=httpx.MockTransport(handler),
    )
    import asyncio
    try:
        asyncio.run(client.query(workspace="tenant-b__enterprise_shared", query="hello", limit=5))
    finally:
        asyncio.run(client.aclose())
    assert seen == ["tenant-b__enterprise_shared"]
