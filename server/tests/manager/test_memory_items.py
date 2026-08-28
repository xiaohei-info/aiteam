from __future__ import annotations

import json
from unittest.mock import Mock

import httpx
import pytest
from fastapi.testclient import TestClient

from manager_service.hindsight_client import HindsightClient, HindsightSettings, HindsightUnavailable
from manager_service.memory_service import MemoryService
from shared.contracts.snapshot import EmployeeExecutionSnapshot
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden


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
        memory_policy={"enabled": True},
    )


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
        _ctx(), employee_id="employee-a", query=None, limit=10, offset=0,
    )

    assert result["items"] == [{
        "memory_id": "memory-a", "employee_id": "employee-a", "content": "remember",
        "category": "world", "importance": None, "source": "tool",
        "created_at": "2026-08-26T00:00:00Z", "last_used_at": None, "state": "valid",
    }]
    assert "cwd" not in result["items"][0]


def test_memory_delete_binds_memory_id_to_authorized_employee():
    snapshot = Mock()
    snapshot.generate.return_value = _snapshot()
    backend = Mock()
    backend.delete.return_value = {"status": "pending"}

    result = MemoryService(snapshot=snapshot, backend=backend).delete(
        _ctx(), employee_id="employee-a", memory_id="memory-from-employee-b",
        idempotency_key="stable-key",
    )

    assert result == {"status": "pending"}
    backend.delete.assert_called_once_with(
        _ctx(), employee_id="employee-a", memory_id="memory-from-employee-b",
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
