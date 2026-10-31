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
        "total": 1, "limit": 100, "offset": 0, "scope": "mine", "truncated": False,
    }
    client, headers = _route_client(service)

    response = client.get(
        "/api/manager/memories",
        params={"employee_id": "employee-a"},
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json()["data"][0]["memory_id"] == "memory-a"
    assert response.json()["data"][0]["contributor_member_id"] is None
    assert response.json()["data"][0]["is_mine"] is False
    assert response.json()["meta"]["scope"] == "mine"
    service.list.assert_called_once_with(
        _ctx(), employee_id="employee-a", query=None, limit=100, offset=0, scope=None,
    )


def test_memory_route_forwards_requested_scope_and_rejects_unknown_scope():
    service = Mock()
    service.list.return_value = {"items": [], "total": 0, "limit": 100, "offset": 0, "scope": "mine", "truncated": False}
    client, headers = _route_client(service)

    assert client.get("/api/manager/memories", params={"employee_id": "employee-a", "scope": "all"}, headers=headers).status_code == 200
    assert service.list.call_args.kwargs["scope"] == "all"
    assert client.get("/api/manager/memories", params={"employee_id": "employee-a", "scope": "team"}, headers=headers).status_code == 422


def test_memory_summary_route_returns_counts_without_content():
    service = Mock()
    service.summary.return_value = {
        "employee_id": "employee-a", "scope": "mine", "total_count": 2, "own_count": 2,
        "others_count": 3, "unattributed_count": 1, "recent_count": 1,
        "latest_used_at": None, "truncated": False,
    }
    client, headers = _route_client(service)

    response = client.get("/api/manager/memories/summary", params={"employee_id": "employee-a"}, headers=headers)

    assert response.status_code == 200, response.text
    assert response.json()["data"]["others_count"] == 3
    service.summary.assert_called_once_with(_ctx(), employee_id="employee-a", scope=None)


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
        "contributor_member_id": None, "contributor_display_name": None, "is_mine": False,
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
        "contributor_member_id": None, "contributor_display_name": None, "is_mine": False,
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


def test_member_cannot_update_memory_even_with_permissive_policy():
    snapshot = Mock()
    snapshot.generate.return_value = _snapshot()
    backend = Mock()
    with pytest.raises(Forbidden):
        MemoryService(snapshot=snapshot, backend=backend).update(
            _ctx(), employee_id="employee-a", memory_id="m", payload={"text": "denied"},
        )
    assert backend.mock_calls == []


# --- Member scope: contributors stamped at retain, members see only their own ---

def _bank_rows():
    return [
        {"id": "mine-1", "text": "mine one", "type": "world", "date": "2099-01-01T00:00:00Z",
         "metadata": {"contributor_member_id": "member-a"}},
        {"id": "other-1", "text": "OTHER_SECRET", "type": "world", "metadata": {"contributor_member_id": "member-b"}},
        {"id": "legacy-1", "text": "LEGACY_SECRET", "type": "world", "metadata": {"source": "context_reset"}},
        {"id": "mine-gone", "text": "mine deleted", "type": "world", "state": "invalidated",
         "metadata": {"contributor_member_id": "member-a"}},
        {"id": "mine-2", "text": "mine two", "type": "experience", "last_used_at": "2026-10-30T02:00:00Z",
         "metadata": {"contributor_member_id": "member-a"}},
    ]


class _Bank:
    """Plain Hindsight list/delete fake; pages are honored so bounded scans terminate."""

    def __init__(self, rows=None):
        self.rows = _bank_rows() if rows is None else rows
        self.list_calls = []
        self.deleted = []

    def list(self, ctx, *, employee_id, query, limit, offset):
        self.list_calls.append({"limit": limit, "offset": offset})
        return {"items": self.rows[offset:offset + limit], "total": len(self.rows)}

    def delete(self, ctx, *, employee_id, memory_id, idempotency_key):
        self.deleted.append(memory_id)
        return {"status": "pending"}


def _scoped_service(bank, *, member_reader=None):
    snapshot = Mock()
    snapshot.generate.return_value = _snapshot()
    return MemoryService(snapshot=snapshot, backend=bank, member_reader=member_reader)


def _owner():
    return _ctx().model_copy(update={"roles": ["owner"]})


def test_member_list_is_forced_to_own_contributions_even_when_requesting_all():
    bank = _Bank()
    result = _scoped_service(bank).list(_ctx(), employee_id="employee-a", query=None, limit=10, offset=0, scope="all")

    assert result["scope"] == "mine"
    assert [item["memory_id"] for item in result["items"]] == ["mine-1", "mine-2"]
    assert result["total"] == 2
    assert all(item["is_mine"] and item["contributor_member_id"] == "member-a" for item in result["items"])
    serialized = json.dumps(result)
    assert "OTHER_SECRET" not in serialized and "LEGACY_SECRET" not in serialized


def test_member_list_paginates_within_own_contributions():
    bank = _Bank()
    result = _scoped_service(bank).list(_ctx(), employee_id="employee-a", query=None, limit=1, offset=1)
    assert [item["memory_id"] for item in result["items"]] == ["mine-2"]
    assert result["total"] == 2 and result["truncated"] is False


def test_member_scan_reports_truncation_beyond_bounded_pages():
    rows = [{"id": f"m-{i}", "text": "x", "type": "world", "metadata": {"contributor_member_id": "member-a"}} for i in range(32 * 200 + 1)]
    result = _scoped_service(_Bank(rows)).list(_ctx(), employee_id="employee-a", query=None, limit=5, offset=0)
    assert result["truncated"] is True
    assert result["total"] == 32 * 200


def test_manager_list_defaults_to_all_and_keeps_paged_upstream_behavior():
    bank = _Bank()
    result = _scoped_service(bank).list(_owner(), employee_id="employee-a", query=None, limit=10, offset=0)

    assert result["scope"] == "all"
    assert bank.list_calls == [{"limit": 10, "offset": 0}]
    by_id = {item["memory_id"]: item for item in result["items"]}
    assert by_id["legacy-1"]["contributor_member_id"] is None and by_id["legacy-1"]["is_mine"] is False
    assert by_id["other-1"]["contributor_member_id"] == "member-b" and by_id["other-1"]["is_mine"] is False


def test_manager_can_narrow_to_own_contributions():
    result = _scoped_service(_Bank()).list(_owner(), employee_id="employee-a", query=None, limit=10, offset=0, scope="mine")
    assert [item["memory_id"] for item in result["items"]] == ["mine-1", "mine-2"]


def test_member_list_requires_an_enabled_memory_policy():
    snapshot = Mock()
    snapshot.generate.return_value = _snapshot()
    snapshot.generate.return_value.memory_policy = {"enabled": False}
    bank = _Bank()
    with pytest.raises(Forbidden):
        MemoryService(snapshot=snapshot, backend=bank).list(_ctx(), employee_id="employee-a", query=None, limit=10, offset=0)
    assert bank.list_calls == []


def test_member_list_still_requires_current_employee_grant():
    snapshot = Mock()
    snapshot.generate.side_effect = Forbidden("member is not authorized for this expert")
    bank = _Bank()
    with pytest.raises(Forbidden):
        MemoryService(snapshot=snapshot, backend=bank).list(_ctx(), employee_id="employee-b", query=None, limit=10, offset=0)
    assert bank.list_calls == []


def test_list_attaches_contributor_display_names_and_tolerates_lookup_failure():
    class Members:
        def get_member(self, ctx, *, member_id):
            if member_id == "member-b":
                raise RuntimeError("directory down")
            return SimpleNamespace(display_name="成员甲")

    result = _scoped_service(_Bank(), member_reader=Members()).list(_owner(), employee_id="employee-a", query=None, limit=10, offset=0)
    names = {item["memory_id"]: item["contributor_display_name"] for item in result["items"]}
    assert names["mine-1"] == "成员甲"
    assert names["other-1"] is None
    assert names["legacy-1"] is None


def test_member_summary_counts_others_and_legacy_without_content():
    result = _scoped_service(_Bank()).summary(_ctx(), employee_id="employee-a", scope="all")

    assert result == {
        "employee_id": "employee-a", "scope": "mine", "total_count": 2, "own_count": 2,
        "others_count": 1, "unattributed_count": 1, "recent_count": 1,
        "latest_used_at": "2026-10-30T02:00:00Z", "truncated": False,
    }


def test_manager_summary_counts_all_valid_memories():
    result = _scoped_service(_Bank()).summary(_owner(), employee_id="employee-a")
    assert result["scope"] == "all"
    assert result["total_count"] == 4
    assert (result["own_count"], result["others_count"], result["unattributed_count"]) == (2, 1, 1)


@pytest.mark.parametrize("memory_id", ["mine-2", "mine-gone"])
def test_member_deletes_own_contribution_including_retry_after_invalidation(memory_id):
    bank = _Bank()
    _scoped_service(bank).delete(_ctx(), employee_id="employee-a", memory_id=memory_id, idempotency_key="k")
    assert bank.deleted == [memory_id]


@pytest.mark.parametrize("memory_id", ["other-1", "legacy-1", "missing"])
def test_member_cannot_delete_others_legacy_or_unknown_memories(memory_id):
    from manager_service.memory_service import MemoryNotContributed

    bank = _Bank()
    with pytest.raises(MemoryNotContributed) as exc_info:
        _scoped_service(bank).delete(_ctx(), employee_id="employee-a", memory_id=memory_id, idempotency_key="k")
    assert exc_info.value.status == 403
    assert exc_info.value.code == "memory_not_contributor"
    assert bank.deleted == []


def test_manager_deletes_any_memory_without_ownership_scan():
    bank = _Bank()
    _scoped_service(bank).delete(_owner(), employee_id="employee-a", memory_id="other-1", idempotency_key="k")
    assert bank.deleted == ["other-1"]
    assert bank.list_calls == []


def test_member_delete_route_maps_not_contributor_to_403_problem():
    from manager_service.memory_service import MemoryNotContributed

    service = Mock()
    service.delete.side_effect = MemoryNotContributed("members can only delete memories they contributed")
    client, headers = _route_client(service)

    response = client.delete("/api/manager/memories/other-1", params={"employee_id": "employee-a"}, headers=headers)

    assert response.status_code == 403
    assert response.json()["code"] == "memory_not_contributor"


def test_retain_stamps_authenticated_contributor_and_strips_client_value_end_to_end():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/profile"):
            from manager_service.hindsight_credentials import derive_hindsight_bank_id
            return httpx.Response(200, json={"bank_id": derive_hindsight_bank_id("tenant-a", "member-a", "employee-a")})
        seen["body"] = json.loads(request.read())
        return httpx.Response(200, json={"success": True, "async": True, "operation_id": "op"})

    backend = HindsightClient(
        HindsightSettings("http://hindsight", "service-token", "/recall", "/v1/default/banks/{bank_id}/memories", "/delete"),
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    snapshot = Mock()
    snapshot.generate.return_value = _snapshot()
    MemoryService(snapshot=snapshot, backend=backend).retain(
        _ctx(), employee_id="employee-a", content="remember",
        metadata={"source": "context_reset", "contributor_member_id": "member-forged"},
    )

    assert seen["body"]["items"][0]["metadata"] == {"source": "context_reset", "contributor_member_id": "member-a"}


def test_guarded_member_list_filters_by_stamped_contributor():
    snapshot = Mock()
    snapshot.generate.return_value = _snapshot()
    snapshot.generate.return_value.memory_policy = {
        "enabled": True, "allowed_operations": ["recall"], "retention_guarded": True, "revision": 1,
    }

    class Backend:
        def retention_request(self, bank, suffix, **kwargs):
            return {"items": [
                {"id": "mine", "text": "mine", "type": "world", "metadata": {"contributor_member_id": "member-a"}},
                {"id": "other", "text": "OTHER_SECRET", "type": "world", "metadata": {"contributor_member_id": "member-b"}},
                {"id": "legacy", "text": "LEGACY_SECRET", "type": "world", "metadata": {}},
            ], "total": 3, "limit": 200, "offset": 0}

    class Retention:
        backend = Backend()
        def require_ready(self, _policy):
            return None
        def filter_recall(self, _ctx, **kwargs):
            return {"results": [{key: fact[key] for key in ("id", "text", "type")} for fact in kwargs["response"]["results"]]}

    service = MemoryService(snapshot=snapshot, backend=Mock(), retention_service=Retention())
    result = service.list(_ctx(), employee_id="employee-a", query=None, limit=10, offset=0)

    assert [item["memory_id"] for item in result["items"]] == ["mine"]
    assert result["items"][0]["is_mine"] is True and result["total"] == 1
    assert "OTHER_SECRET" not in json.dumps(result)
    summary = service.summary(_ctx(), employee_id="employee-a")
    assert (summary["own_count"], summary["others_count"], summary["unattributed_count"]) == (1, 1, 1)
