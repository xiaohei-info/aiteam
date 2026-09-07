from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi.testclient import TestClient

from manager_service.hindsight_client import HindsightClient, HindsightSettings, HindsightUnavailable
from manager_service.memory_service import MemoryService
from shared.contracts.snapshot import EmployeeExecutionSnapshot
from shared.contracts.tenancy import TenantContext
from shared.errors import AppError, Forbidden


def _route_client(service):
    from manager_service.app import router as manager_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient
    from manager_service.routes_memory_items import build_memory_items_router
    from shared.app_factory import create_app
    from shared.config import Settings
    from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token

    verifier, signer = make_inmem_verifier_and_signer()
    app = create_app(
        Settings(tier="manager", service_name="m", db_url="postgresql://fake/fake"),
        manager_router,
    )
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.state._memory_service = service
    app.include_router(build_memory_items_router(verifier))
    token = sign_inmem_token(signer, "tenant-a", ["member"], user_id="member-a")
    return TestClient(app), {"Authorization": f"Bearer {token}"}


def _ctx() -> TenantContext:
    return TenantContext(tenant_id="tenant-a", user_id="member-a", roles=["member"])


def _snapshot(employee_id: str = "employee-a") -> EmployeeExecutionSnapshot:
    return EmployeeExecutionSnapshot(
        employee_id=employee_id,
        version="1",
        snapshot_version="snapshot-a",
        memory_policy={"enabled": True, "allowed_operations": ["recall", "retain"]},
    )


def test_memory_service_update_sanitizes_payload_and_response():
    snapshot = Mock()
    snapshot.generate.return_value = _snapshot()
    backend = Mock()
    backend.update.return_value = {"metadata": {"api_key": "hidden", "label": "ok"}}

    result = MemoryService(snapshot=snapshot, backend=backend).update(
        _ctx().model_copy(update={"roles": ["owner"]}), employee_id="employee-a", memory_id="memory-a", payload={"text": "updated", "api_key": "secret"},
    )

    assert result == {"metadata": {"api_key": "[REDACTED]", "label": "ok"}}
    backend.update.assert_called_once_with(_ctx().model_copy(update={"roles": ["owner"]}), employee_id="employee-a", memory_id="memory-a", payload={"text": "updated", "api_key": "[REDACTED]"})


def test_memory_analytics_without_employee_reader_is_explicitly_unconfigured():
    result = MemoryService(snapshot=Mock(), backend=Mock()).analytics(_ctx())
    assert result["status"] == "not_configured"
    assert result["employees"] == []


def test_memory_route_denies_same_tenant_employee_before_hindsight():
    service = Mock()
    service.recall.side_effect = Forbidden("member is not authorized for this expert")
    client, headers = _route_client(service)

    response = client.get(
        "/api/manager/memories/recall",
        params={"employee_id": "employee-b", "query": "q"},
        headers=headers,
    )

    assert response.status_code == 403
    assert response.headers["content-type"].startswith("application/problem+json")
    service.recall.assert_called_once()


def test_memory_route_lists_scoped_hindsight_items():
    service = Mock()
    service.list.return_value = {
        "items": [{"memory_id": "memory-a", "employee_id": "employee-a", "content": "remember", "category": "world", "importance": None, "source": "hindsight", "created_at": None, "last_used_at": None}],
        "total": 1, "limit": 100, "offset": 0,
    }
    client, headers = _route_client(service)

    response = client.get(
        "/api/manager/memories",
        params={"employee_id": "employee-a"},
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json()["data"][0]["memory_id"] == "memory-a"
    service.list.assert_called_once_with(
        _ctx(), employee_id="employee-a", query=None, limit=100, offset=0,
    )


def test_memory_route_requires_employee_scope_for_delete():
    service = Mock()
    service.delete.return_value = {"status": "pending"}
    client, headers = _route_client(service)

    response = client.delete("/api/manager/memories/memory-a", headers=headers)

    assert response.status_code == 422
    service.delete.assert_not_called()


def test_memory_write_models_reject_blank_text_and_accept_valid_states():
    from manager_service.routes_memory_items import MemoryRetainIn, MemoryUpdateIn

    assert MemoryUpdateIn.model_validate({"state": "valid"}).state == "valid"
    assert MemoryUpdateIn.model_validate({"state": "invalidated"}).state == "invalidated"
    with pytest.raises(ValueError):
        MemoryUpdateIn.model_validate({"text": "   "})
    with pytest.raises(ValueError):
        MemoryRetainIn.model_validate({"employee_id": "employee-a", "content": "\n"})


def test_memory_route_rejects_oversized_metadata_before_service_io():
    service = Mock()
    client, headers = _route_client(service)
    response = client.post(
        "/api/manager/memories",
        headers={**headers, "Content-Length": "1"},
        json={"employee_id": "employee-a", "content": "remember", "metadata": {"blob": "x" * (64 * 1024)}},
    )
    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert service.mock_calls == []
    assert "blob" not in response.text


def test_memory_route_rejects_oversized_body_with_typed_413_before_service_io():
    service = Mock()
    client, headers = _route_client(service)
    response = client.post(
        "/api/manager/memories",
        headers={**headers, "Content-Length": str(256 * 1024 + 1)},
        content=b"{}",
    )
    assert response.status_code == 413
    assert response.json()["code"] == "request_too_large"
    assert service.mock_calls == []


@pytest.mark.asyncio
async def test_memory_route_rejects_chunked_body_before_json_parsing():
    """A missing Content-Length must not bypass the receive-stream limit."""
    service = Mock()
    client, headers = _route_client(service)

    class Chunks(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'{"employee_id":"employee-a","content":"fixture","metadata":{"blob":"'
            yield b"x" * (256 * 1024)
            yield b'"}}'

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=client.app), base_url="http://test"
    ) as async_client:
        response = await async_client.post("/api/manager/memories", headers=headers, content=Chunks())
    assert response.status_code == 413, response.text
    assert response.json()["code"] == "request_too_large"
    assert service.mock_calls == []


def test_memory_route_rejects_oversized_query_before_service_io():
    service = Mock()
    client, headers = _route_client(service)
    response = client.get(
        "/api/manager/memories/recall",
        params={"employee_id": "employee-a", "query": "q" * (16 * 1024 + 1)},
        headers=headers,
    )
    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert service.mock_calls == []


def test_memory_route_returns_native_async_write_acknowledgement():
    service = Mock()
    service.retain.return_value = {"success": True, "async": True, "operation_id": "operation-1"}
    client, headers = _route_client(service)

    response = client.post(
        "/api/manager/memories",
        headers=headers,
        json={"employee_id": "employee-a", "content": "remember", "metadata": {"source": "fixture"}},
    )

    assert response.status_code == 201
    assert response.json()["data"] == {"success": True, "async": True, "operation_id": "operation-1"}
    service.retain.assert_called_once_with(
        _ctx(), employee_id="employee-a", content="remember", metadata={"source": "fixture"},
    )


def test_memory_route_updates_hindsight_item_with_employee_scope():
    service = Mock()
    service.update.return_value = {"status": "updated"}
    client, headers = _route_client(service)

    response = client.patch(
        "/api/manager/memories/memory-a",
        params={"employee_id": "employee-a"},
        json={"content": "updated"},
        headers=headers,
    )

    assert response.status_code == 200
    service.update.assert_called_once_with(
        _ctx(), employee_id="employee-a", memory_id="memory-a", payload={"text": "updated"},
    )


def test_memory_service_denies_non_runnable_employee_before_backend_io():
    class Snapshot:
        def _ensure_runnable(self, ctx, *, employee_id):
            from shared.errors import NotFound
            raise NotFound("employee is not runnable")

        def generate(self, *args, **kwargs):
            raise AssertionError("snapshot generation must not run for a non-runnable employee")

    backend = Mock()
    with pytest.raises(Exception) as exc_info:
        MemoryService(snapshot=Snapshot(), backend=backend).recall(
            _ctx(), employee_id="employee-paused", query="q", limit=1,
        )
    assert exc_info.value.status == 404
    assert backend.mock_calls == []


def test_memory_service_denies_same_tenant_employee_without_current_grant():
    snapshot = Mock()
    snapshot.generate.side_effect = Forbidden("member is not authorized for this expert")
    backend = Mock()

    with pytest.raises(Forbidden):
        MemoryService(snapshot=snapshot, backend=backend).recall(
            _ctx(), employee_id="employee-b", query="q", limit=1
        )
    backend.recall.assert_not_called()
    snapshot.generate.assert_called_once_with(
        _ctx(), member_id="member-a", employee_id="employee-b"
    )


def test_memory_service_accepts_native_hindsight_type_field():
    snapshot = Mock()
    snapshot.generate.return_value = _snapshot()
    backend = Mock()
    backend.list.return_value = {"items": [{"id": "memory-a", "text": "fact", "type": "observation"}], "total": 1}

    result = MemoryService(snapshot=snapshot, backend=backend).list(
        _ctx().model_copy(update={"roles": ["owner"]}), employee_id="employee-a", query=None, limit=10, offset=0,
    )

    assert result["items"][0]["category"] == "observation"


def test_memory_service_maps_native_list_type_and_safe_source_in_guarded_listing():
    snapshot = Mock()
    snapshot.generate.return_value = _snapshot()
    snapshot.generate.return_value.memory_policy = {
        "enabled": True,
        "allowed_operations": ["recall"],
        "retention_guarded": True,
        "revision": 1,
    }

    class Backend:
        def retention_request(self, bank, suffix, **kwargs):
            assert suffix == "memories/list"
            return {"items": [{
                "id": "native-memory",
                "text": "native fact",
                "type": "world",
                "metadata": {"source": "fixture"},
                "document_id": "doc-1",
            }], "total": 1, "limit": 200, "offset": 0}

    class Retention:
        backend = Backend()
        def require_ready(self, _policy):
            return None
        def filter_recall(self, _ctx, **kwargs):
            return {"results": [
                {key: fact[key] for key in ("id", "text", "type")}
                for fact in kwargs["response"]["results"]
            ]}

    result = MemoryService(snapshot=snapshot, backend=Mock(), retention_service=Retention()).list(
        _ctx().model_copy(update={"roles": ["owner"]}),
        employee_id="employee-a", query=None, limit=10, offset=0,
    )

    assert result["items"] == [{
        "memory_id": "native-memory", "employee_id": "employee-a", "content": "native fact",
        "category": "world", "importance": None, "source": "fixture",
        "created_at": None, "last_used_at": None, "state": "valid",
    }]


def test_memory_list_uses_fact_type_only_as_legacy_fallback_and_discards_unsafe_text_source():
    from manager_service.memory_service import normalize_memory_list

    result = normalize_memory_list({"items": [
        {"id": "legacy", "text": "legacy fact", "fact_type": "experience", "metadata": {"retainSource": "legacy"}},
        {"id": "empty", "text": "   ", "source": "not-used"},
        {"id": "unsafe", "text": "safe", "source": "fixture\nforged"},
    ]}, employee_id="employee-a", limit=10, offset=0)

    assert result["items"][0]["category"] == "experience"
    assert result["items"][0]["source"] == "legacy"
    assert [item["memory_id"] for item in result["items"]] == ["legacy", "unsafe"]
    assert result["items"][1]["source"] == "hindsight"


def test_memory_analytics_filters_denied_and_reports_partial_upstream():
    class Snapshot:
        def generate(self, ctx, *, member_id, employee_id, employee_version=None):
            return _snapshot(employee_id)
    class Employees:
        def list_all(self, ctx):
            return [SimpleNamespace(employee_id="e1", display_name="One"), SimpleNamespace(employee_id="e2", display_name="Two")]

    class Backend:
        def stats(self, ctx, *, employee_id):
            return {}
        def list(self, ctx, *, employee_id, query, limit, offset):
            if employee_id == "e1":
                raise HindsightUnavailable("down")
            return {"items": [{"id": "m2", "text": "ok", "type": "world"}], "total": 1}

    result = MemoryService(snapshot=Snapshot(), backend=Backend(), employee_reader=Employees()).analytics(
        TenantContext(tenant_id="tenant-a", user_id="member-a", roles=["owner"]),
    )
    assert result["status"] == "partial"
    assert result["employee_count"] == 1
    assert result["unavailable_employee_count"] == 1


def test_memory_analytics_skips_empty_employee_ids_and_forbidden_members():
    class Employees:
        def list_all(self, ctx):
            return [Mock(employee_id=""), SimpleNamespace(employee_id="e1", display_name="Hidden")]

    class Backend:
        def list(self, *args, **kwargs):
            raise Forbidden("denied")

    class Snapshot:
        def generate(self, ctx, *, member_id, employee_id, employee_version=None):
            return _snapshot(employee_id)

    result = MemoryService(snapshot=Snapshot(), backend=Backend(), employee_reader=Employees()).analytics(
        TenantContext(tenant_id="tenant-a", user_id="member-a", roles=["member"]),
    )
    assert result["employees"] == []


def test_memory_analytics_reraises_unexpected_app_error():
    class Snapshot:
        def generate(self, ctx, *, member_id, employee_id, employee_version=None):
            return _snapshot(employee_id)
    class Employees:
        def list_all(self, ctx):
            return [SimpleNamespace(employee_id="e1", display_name="One")]

    class Backend:
        def list(self, *args, **kwargs):
            raise AppError("boom")
        def stats(self, *args, **kwargs):
            return {}

    with pytest.raises(AppError):
        MemoryService(snapshot=Snapshot(), backend=Backend(), employee_reader=Employees()).analytics(
            TenantContext(tenant_id="tenant-a", user_id="member-a", roles=["owner"]),
        )


def test_memory_service_normalizes_hindsight_list_without_metadata_leaks():
    snapshot = Mock()
    snapshot.generate.return_value = _snapshot()
    backend = Mock()
    backend.list.return_value = {
        "items": [{
            "id": "memory-a", "text": "remember", "fact_type": "world",
            "date": "2026-08-26T00:00:00Z", "metadata": {"cwd": "/private/workspace", "retainSource": "tool"},
        }],
        "total": 1,
    }

    result = MemoryService(snapshot=snapshot, backend=backend).list(
        _ctx().model_copy(update={"roles": ["owner"]}), employee_id="employee-a", query=None, limit=10, offset=0,
    )

    assert result["items"] == [{
        "memory_id": "memory-a", "employee_id": "employee-a", "content": "remember",
        "category": "world", "importance": None, "source": "tool",
        "created_at": "2026-08-26T00:00:00Z", "last_used_at": None, "state": "valid",
    }]
    assert "cwd" not in result["items"][0]


def test_normalize_memory_list_discards_malformed_rows_and_defaults_total():
    from manager_service.memory_service import normalize_memory_list

    result = normalize_memory_list({"items": [None, {"id": "", "text": "bad"}, {"id": "ok", "text": "good", "importance": float("nan")}]}, employee_id="e", limit=10, offset=0)
    assert result["total"] == 1
    assert result["items"][0]["memory_id"] == "ok"
    assert result["items"][0]["importance"] is None
    assert normalize_memory_list({"items": "bad"}, employee_id="e", limit=10, offset=0)["items"] == []


def test_memory_delete_binds_memory_id_to_authorized_employee():
    snapshot = Mock()
    snapshot.generate.return_value = _snapshot()
    backend = Mock()
    backend.delete.return_value = {"status": "pending"}

    result = MemoryService(snapshot=snapshot, backend=backend).delete(
        _ctx().model_copy(update={"roles": ["owner"]}), employee_id="employee-a", memory_id="memory-from-employee-b",
        idempotency_key="stable-key",
    )

    assert result == {"status": "pending"}
    backend.delete.assert_called_once_with(
        _ctx().model_copy(update={"roles": ["owner"]}), employee_id="employee-a", memory_id="memory-from-employee-b",
        idempotency_key="stable-key",
    )


def test_memory_service_sanitizes_token_bearing_metadata_before_hindsight():
    snapshot = Mock()
    snapshot.generate.return_value = _snapshot()
    backend = Mock()
    backend.retain.return_value = {"metadata": {"api_key": "upstream-secret", "label": "ok"}}

    result = MemoryService(snapshot=snapshot, backend=backend).retain(
        _ctx(), employee_id="employee-a", content="remember", metadata={
            "nested": {"Authorization": "Bearer user-token", "label": "ok"}
        },
    )

    forwarded = backend.retain.call_args.kwargs["metadata"]
    assert forwarded == {"nested": {"Authorization": "[REDACTED]", "label": "ok"}}
    assert result == {"metadata": {"api_key": "[REDACTED]", "label": "ok"}}


@pytest.mark.parametrize(
    "settings, operation",
    [
        (HindsightSettings(None, "token", "/recall", "/retain", "/delete"), "recall"),
        (HindsightSettings("http://hindsight", None, "/recall", "/retain", "/delete"), "recall"),
        (HindsightSettings("http://hindsight", "token", None, "/retain", "/delete"), "recall"),
        (HindsightSettings("http://hindsight", "token", "/recall", None, "/delete"), "retain"),
        (HindsightSettings("http://hindsight", "token", "/recall", "/retain", None), "delete"),
    ],
)
def test_hindsight_missing_auth_or_operation_config_fails_before_outbound(settings, operation):
    def fail_transport(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("unconfigured Hindsight must not make an outbound request")

    client = HindsightClient(
        settings,
        client=httpx.Client(transport=httpx.MockTransport(fail_transport)),
    )
    with pytest.raises(HindsightUnavailable):
        if operation == "recall":
            client.recall(_ctx(), employee_id="employee-a", query="q", limit=1)
        elif operation == "retain":
            client.retain(_ctx(), employee_id="employee-a", content="x", metadata={})
        else:
            client.delete(
                _ctx(), employee_id="employee-a", memory_id="memory-a",
                idempotency_key="stable-key",
            )


def test_hindsight_delete_sends_employee_scope_and_stable_idempotency_key():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/profile"):
            from manager_service.hindsight_credentials import derive_hindsight_bank_id
            return httpx.Response(200, json={"bank_id": derive_hindsight_bank_id("tenant-a", "member-a", "employee-a")})
        seen["headers"] = dict(request.headers)
        seen["body"] = request.read()
        return httpx.Response(200, json={"status": "pending"})

    client = HindsightClient(
        HindsightSettings("http://hindsight", "service-token", "/recall", "/retain", "/v1/default/banks/{bank_id}/memories/{memory_id}"),
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    result = client.delete(
        _ctx(), employee_id="employee-a", memory_id="memory-from-employee-b",
        idempotency_key="stable-key",
    )

    assert result == {"status": "pending"}
    assert seen["headers"]["authorization"] == "Bearer service-token"
    assert seen["headers"]["idempotency-key"] == "stable-key"
    assert seen["headers"]["x-member-id"] == "member-a"
    assert json.loads(seen["body"]) == {"state": "invalidated", "reason": "deleted by Manager"}


@pytest.mark.parametrize("operation,kwargs", [
    ("list", {"query": None, "limit": 10, "offset": 0}),
    ("update", {"memory_id": "m", "payload": {"text": "denied"}}),
    ("delete", {"memory_id": "m", "idempotency_key": "fixture"}),
])
def test_member_cannot_use_memory_management_even_with_permissive_policy(operation, kwargs):
    snapshot = Mock()
    snapshot.generate.return_value = _snapshot()
    backend = Mock()
    with pytest.raises(Forbidden):
        getattr(MemoryService(snapshot=snapshot, backend=backend), operation)(_ctx(), employee_id="employee-a", **kwargs)
    assert backend.mock_calls == []
