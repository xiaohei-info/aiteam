"""Static Manager-owned LightRAG instance-pool contract tests."""

from __future__ import annotations

import json
import socket

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
        json.dumps([{"instance_id": "a", "url": "http://rag", "api_key": "k", "workspace": 1}]),
        json.dumps([{"instance_id": "a", "url": "http://rag", "api_key": "k", "workspace": "w\n"}]),
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


def test_workspace_only_legacy_hint_is_ignored(monkeypatch):
    monkeypatch.delenv("LIGHTRAG_INSTANCES", raising=False)
    monkeypatch.delenv("LIGHTRAG_URL", raising=False)
    monkeypatch.delenv("LIGHTRAG_API_KEY", raising=False)
    monkeypatch.setenv("LIGHTRAG_WORKSPACE", "old-fixed")
    assert RagInstanceRegistry.from_env() is None


def test_legacy_env_requires_url_and_api_key(monkeypatch):
    monkeypatch.delenv("LIGHTRAG_INSTANCES", raising=False)
    monkeypatch.delenv("LIGHTRAG_URL", raising=False)
    monkeypatch.setenv("LIGHTRAG_API_KEY", "secret")
    with pytest.raises(RagInstanceConfigurationError, match="URL and LIGHTRAG_API_KEY"):
        RagInstanceRegistry.from_env()


def test_query_settings_load_from_legacy_env(monkeypatch):
    monkeypatch.delenv("LIGHTRAG_INSTANCES", raising=False)
    monkeypatch.setenv("LIGHTRAG_URL", "http://rag/base/")
    monkeypatch.setenv("LIGHTRAG_API_KEY", "secret")
    settings = LightRagSettings.from_env()
    assert settings is not None
    assert settings.url == "http://rag/base"
    assert settings.api_key == "secret"
    assert settings.instance_registry is not None


def test_empty_instance_pool_env_uses_legacy_endpoint(monkeypatch):
    monkeypatch.setenv("LIGHTRAG_INSTANCES", "")
    monkeypatch.setenv("LIGHTRAG_URL", "http://rag")
    monkeypatch.setenv("LIGHTRAG_API_KEY", "secret")
    registry = RagInstanceRegistry.from_env()
    assert registry is not None
    assert registry.instances[0].instance_id == "legacy"


def test_production_registry_requires_global_dns_resolution(monkeypatch):
    monkeypatch.setenv("AITEAM_ENV", "production")
    monkeypatch.setenv("LIGHTRAG_INSTANCES", json.dumps([
        {"instance_id": "rag-a", "url": "https://rag.example", "api_key": "secret-a"},
    ]))
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))])
    assert RagInstanceRegistry.from_env() is not None

    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.2", 443))])
    with pytest.raises(RagInstanceConfigurationError, match="global destinations"):
        RagInstanceRegistry.from_env()


def test_production_registry_fails_closed_when_dns_lookup_fails(monkeypatch):
    monkeypatch.setenv("AITEAM_ENV", "production")
    monkeypatch.setenv("LIGHTRAG_URL", "https://rag.example")
    monkeypatch.setenv("LIGHTRAG_API_KEY", "secret")
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("dns down")))
    with pytest.raises(RagInstanceConfigurationError, match="DNS resolution failed"):
        RagInstanceRegistry.from_env()


def test_production_registry_requires_https_for_pool_and_legacy_modes(monkeypatch):
    monkeypatch.setenv("AITEAM_ENV", "production")
    monkeypatch.setenv("LIGHTRAG_INSTANCES", json.dumps([
        {"instance_id": "rag-a", "url": "http://rag-a", "api_key": "secret-a"},
    ]))
    with pytest.raises(RagInstanceConfigurationError, match="must use HTTPS"):
        RagInstanceRegistry.from_env()

    monkeypatch.delenv("LIGHTRAG_INSTANCES", raising=False)
    monkeypatch.setenv("LIGHTRAG_URL", "http://rag")
    monkeypatch.setenv("LIGHTRAG_API_KEY", "secret")
    with pytest.raises(RagInstanceConfigurationError, match="must use HTTPS"):
        RagInstanceRegistry.from_env()


@pytest.mark.parametrize("url", ["https://127.0.0.2", "https://[::ffff:127.0.0.1]", "https://localhost.local"])
def test_production_registry_rejects_all_local_endpoint_literals(monkeypatch, url):
    monkeypatch.setenv("AITEAM_ENV", "production")
    monkeypatch.setenv("LIGHTRAG_URL", url)
    monkeypatch.setenv("LIGHTRAG_API_KEY", "secret")
    with pytest.raises(RagInstanceConfigurationError, match="local destinations"):
        RagInstanceRegistry.from_env()


@pytest.mark.parametrize("url", ["https://rag.example/v1 bad", "https://rag.example:bad"])
def test_registry_rejects_malformed_url(monkeypatch, url):
    monkeypatch.setenv("LIGHTRAG_URL", url)
    monkeypatch.setenv("LIGHTRAG_API_KEY", "secret")
    with pytest.raises(RagInstanceConfigurationError):
        RagInstanceRegistry.from_env()


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


def test_clients_honor_persisted_instance_id_after_registry_reorder():
    registry = _registry(
        {"instance_id": "rag-a", "url": "http://rag-a", "api_key": "secret-a"},
        {"instance_id": "rag-b", "url": "http://rag-b", "api_key": "secret-b"},
    )
    query_seen: list[tuple[str, str]] = []

    async def query_handler(request: httpx.Request):
        query_seen.append((str(request.url), request.headers["x-api-key"]))
        return httpx.Response(200, json={"status": "success", "data": {"references": []}})

    query = LightRagClient(
        LightRagSettings("unused", "unused", instance_registry=registry),
        transport=httpx.MockTransport(query_handler),
    )
    import asyncio
    try:
        asyncio.run(query.query(
            workspace="space-b", query="hello", limit=5, instance_id="rag-b"
        ))
    finally:
        asyncio.run(query.aclose())
    assert query_seen == [("http://rag-b/query/data", "secret-b")]

    ingestion_seen: list[tuple[str, str]] = []

    def ingestion_handler(request: httpx.Request):
        ingestion_seen.append((str(request.url), request.headers["x-api-key"]))
        return httpx.Response(200, json={
            "documents": [],
            "pagination": {"page": 1, "page_size": 100, "total_pages": 0, "total_count": 0, "has_next": False},
        })

    ingestion = LightRagIngestionClient(
        LightRagIngestionSettings("unused", "unused", 100, 1000, 1, instance_registry=registry),
        transport=httpx.MockTransport(ingestion_handler),
    )
    try:
        assert ingestion.list_documents(workspace="space-b", instance_id="rag-b") == []
    finally:
        ingestion.close()
    assert ingestion_seen == [("http://rag-b/documents/paginated", "secret-b")]
    with pytest.raises(RagInstanceConfigurationError):
        # Preferred endpoint selection must not bypass workspace validation.
        registry.validate_workspace("bad\nworkspace")


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
