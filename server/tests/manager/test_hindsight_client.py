from __future__ import annotations

import httpx
import json
import pytest

from manager_service.hindsight_client import (
    HindsightClient, HindsightSettings, HindsightUnavailable,
    _derive_stats_path, _derive_update_path,
)
from shared.contracts.tenancy import TenantContext
from manager_service.hindsight_credentials import derive_hindsight_bank_id

BANK = derive_hindsight_bank_id("tenant-a", "u", "employee-a")


def test_hindsight_path_derivation_handles_native_and_legacy_routes():
    assert _derive_stats_path(None) is None
    assert _derive_stats_path("/legacy/list") is None
    assert _derive_stats_path("/v1/default/banks/{bank_id}/memories/list") == "/v1/default/banks/{bank_id}/stats"
    assert _derive_update_path(None, None) is None
    assert _derive_update_path("/v1/default/banks/{bank_id}/memories/{memory_id}", None).endswith("/{memory_id}")
    assert _derive_update_path("/v1/default/banks/{bank_id}/memories/list", None).endswith("/memories/{memory_id}")
    assert _derive_update_path(None, "/legacy/delete").endswith("/{memory_id}")


def test_hindsight_client_sends_tenant_context_and_never_falls_back():
    seen = {"methods": []}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/profile"):
            return httpx.Response(200, json={"bank_id": BANK})
        seen["methods"].append(request.method)
        seen["path"] = request.url.path
        seen["tenant"] = request.headers["X-Tenant-ID"]
        seen["member"] = request.headers["X-Member-ID"]
        seen["body"] = request.read()
        return httpx.Response(200, json={"items": []})

    client = HindsightClient(
        HindsightSettings("http://hindsight", "secret", "/v1/default/banks/{bank_id}/memories/recall", "/retain", "/delete"),
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    result = client.recall(TenantContext(tenant_id="tenant-a", user_id="u", roles=[]),
                           employee_id="employee-a", query="hello", limit=3)
    assert result == {"items": []}
    assert seen["methods"] == ["POST"]
    assert seen["path"] == f"/v1/default/banks/{BANK}/memories/recall"
    assert seen["tenant"] == "tenant-a"
    assert seen["member"] == "u"
    assert json.loads(seen["body"]) == {"query": "hello", "max_tokens": 768}


def test_env_backed_hindsight_defaults_to_native_paths(monkeypatch):
    monkeypatch.setenv("HINDSIGHT_URL", "http://hindsight")
    monkeypatch.setenv("HINDSIGHT_SERVICE_TOKEN", "manager-secret")
    monkeypatch.delenv("HINDSIGHT_RECALL_PATH", raising=False)
    monkeypatch.delenv("HINDSIGHT_RETAIN_PATH", raising=False)
    monkeypatch.delenv("HINDSIGHT_DELETE_PATH", raising=False)
    settings = HindsightSettings.from_env()
    assert settings.recall_path.endswith("/memories/recall")
    assert settings.retain_path.endswith("/memories")
    assert settings.delete_path.endswith("/memories/{memory_id}")
    assert settings.stats_path.endswith("/stats")


def test_env_backed_hindsight_client_uses_manager_derived_bank_scope(monkeypatch):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/profile"):
            return httpx.Response(200, json={"bank_id": BANK})
        seen["path"] = request.url.path
        return httpx.Response(200, json={"items": []})

    monkeypatch.setenv("HINDSIGHT_URL", "http://hindsight")
    monkeypatch.setenv("HINDSIGHT_SERVICE_TOKEN", "manager-secret")
    monkeypatch.setenv("HINDSIGHT_RECALL_PATH", "/v1/default/banks/{bank_id}/memories/recall")
    client = HindsightClient(
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    client.recall(TenantContext(tenant_id="tenant-a", user_id="u", roles=[]), employee_id="employee-a", query="q", limit=1)
    from manager_service.hindsight_credentials import derive_hindsight_bank_id

    assert seen["path"] == f"/v1/default/banks/{derive_hindsight_bank_id('tenant-a', 'u', 'employee-a')}/memories/recall"


def test_hindsight_client_lists_memory_units_with_pagination():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/profile"):
            return httpx.Response(200, json={"bank_id": BANK})
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["query"] = dict(request.url.params)
        return httpx.Response(200, json={"items": [], "total": 0})

    client = HindsightClient(
        HindsightSettings(
            "http://hindsight", "secret", "/recall", "/retain", "/delete",
            list_path="/v1/default/banks/{bank_id}/memories/list",
        ),
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    result = client.list(
        TenantContext(tenant_id="tenant-a", user_id="u", roles=[]),
        employee_id="employee-a", query="hello", limit=10, offset=20,
    )

    assert result == {"items": [], "total": 0}
    assert seen == {
        "method": "GET",
        "path": f"/v1/default/banks/{BANK}/memories/list",
        "query": {"q": "hello", "limit": "10", "offset": "20"},
    }


def test_hindsight_client_reads_native_bank_stats():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/profile"):
            return httpx.Response(200, json={"bank_id": BANK})
        seen["method"] = request.method
        seen["path"] = request.url.path
        return httpx.Response(200, json={"total_nodes": 2})

    client = HindsightClient(
        HindsightSettings("http://hindsight", "secret", "/recall", "/retain", "/delete", list_path="/v1/default/banks/{bank_id}/memories/list"),
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    assert client.stats(TenantContext(tenant_id="tenant-a", user_id="u", roles=[]), employee_id="employee-a") == {"total_nodes": 2}
    assert seen == {"method": "GET", "path": f"/v1/default/banks/{BANK}/stats"}


def test_hindsight_update_does_not_reuse_delete_action_path():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/profile"):
            return httpx.Response(200, json={"bank_id": BANK})
        seen["method"] = request.method
        seen["path"] = request.url.path
        return httpx.Response(200, json={"id": "memory-1", "text": "updated"})

    settings = HindsightSettings(
        "http://hindsight", "secret", "/recall", "/retain", "/v1/default/banks/{bank_id}/memories/delete",
        list_path="/v1/default/banks/{bank_id}/memories/list",
    )
    client = HindsightClient(settings, client=httpx.Client(transport=httpx.MockTransport(handler)))
    result = client.update(
        TenantContext(tenant_id="tenant-a", user_id="u", roles=[]),
        employee_id="employee-a", memory_id="memory-1", payload={"text": "updated"},
    )

    assert result == {"id": "memory-1", "text": "updated"}
    assert seen == {
        "method": "PATCH",
        "path": f"/v1/default/banks/{BANK}/memories/memory-1",
    }


def test_hindsight_unconfigured_fails_closed():
    client = HindsightClient(HindsightSettings(None, None, None, None, None))
    with pytest.raises(HindsightUnavailable):
        client.recall(TenantContext(tenant_id="t", user_id="u", roles=[]),
                      employee_id="e", query="q", limit=1)


def test_retention_transport_bounds_stream_before_consuming_remaining_body():
    consumed = []
    class Stream(httpx.SyncByteStream):
        def __iter__(self):
            for index in range(10):
                consumed.append(index)
                yield b"x" * 1024 * 1024
    settings = HindsightSettings("http://fixture", "fixture-only", None, None, None)
    native = HindsightClient(settings, client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, stream=Stream()))))
    with pytest.raises(HindsightUnavailable, match="exceeds the limit"):
        native.retention_request("fixture-bank", "memories/list")
    assert consumed == [0, 1, 2]


def test_retention_transport_never_follows_redirect_or_returns_upstream_error_body():
    calls = []
    def upstream(request):
        calls.append(request.url)
        return httpx.Response(302, headers={"Location":"http://elsewhere/private"}, text="BODY_SECRET")
    settings = HindsightSettings("http://fixture", "fixture-only", None, None, None)
    native = HindsightClient(settings, client=httpx.Client(transport=httpx.MockTransport(upstream), follow_redirects=True))
    with pytest.raises(HindsightUnavailable) as error:
        native.retention_request("fixture-bank", "memories/list")
    assert "BODY_SECRET" not in str(error.value) and len(calls) == 1


def test_retention_stream_cannot_extend_deadline_by_dripping_small_chunks(monkeypatch):
    times = iter([100, 111])
    monkeypatch.setattr("manager_service.hindsight_client.monotonic", lambda: next(times))
    settings = HindsightSettings("http://fixture", "fixture-only", None, None, None)
    native = HindsightClient(settings, client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"items":[]}))))
    with pytest.raises(HindsightUnavailable, match="timed out"):
        native.retention_request("fixture-bank", "memories/list")
