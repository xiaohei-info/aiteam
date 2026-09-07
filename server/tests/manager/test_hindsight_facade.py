from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock
import httpx
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from manager_service.hindsight_client import HindsightSettings
from manager_service.hindsight_credentials import HindsightLeaseStore
from manager_service.hindsight_facade import HindsightFacade
from shared.errors import install_exception_handlers
from tests.manager.test_hindsight_credentials import _Snapshot


def _settings() -> HindsightSettings:
    return HindsightSettings(
        "https://hindsight.internal",
        "manager-service-secret",
        "/recall",
        "/retain",
        "/delete",
    )


def _app(facade: HindsightFacade) -> FastAPI:
    app = FastAPI()
    install_exception_handlers(app)

    @app.api_route(
        "/api/manager/hindsight/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    )
    async def proxy(request: Request, path: str):
        return await facade.proxy(request, path)

    return app


def test_facade_substitutes_manager_token_and_rejects_wrong_bank():
    settings = _settings()
    leases = HindsightLeaseStore(token_factory=lambda: "opaque-agent-lease")
    lease = leases.issue(
        tenant_id="tenant-1",
        member_id="member-1",
        employee_id="employee-1",
        snapshot_version="snap-1",
        policy={"enabled": True},
        bank_id="bank-a",
    )
    seen: dict[str, object] = {}

    def upstream(request: httpx.Request) -> httpx.Response:
        seen["authorization"] = request.headers.get("authorization")
        seen["tenant"] = request.headers.get("x-tenant-id")
        seen["path"] = request.url.path
        return httpx.Response(200, json={"ok": True})

    external = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    app = _app(HindsightFacade(settings=settings, leases=leases, client=external, principal_repository=Mock(find_user=Mock(return_value=SimpleNamespace(status="active", roles=["member"]))), snapshot_service=_Snapshot({"enabled": True})))
    client = TestClient(app)
    response = client.post(
        "/api/manager/hindsight/v1/default/banks/bank-a/memories/recall",
        headers={"Authorization": f"Bearer {lease.token}"},
        json={"query": "hello"},
    )
    assert response.status_code == 200
    assert seen == {
        "authorization": "Bearer manager-service-secret",
        "tenant": "tenant-1",
        "path": "/v1/default/banks/bank-a/memories/recall",
    }
    assert lease.token not in str(seen)

    wrong = client.post(
        "/api/manager/hindsight/v1/default/banks/bank-b/memories/recall",
        headers={"Authorization": f"Bearer {lease.token}"},
        json={"query": "hello"},
    )
    assert wrong.status_code == 403


def test_facade_fails_closed_after_revoke_and_does_not_accept_bank_query_or_body():
    settings = _settings()
    leases = HindsightLeaseStore(token_factory=lambda: "opaque-agent-lease")
    lease = leases.issue(
        tenant_id="tenant-1",
        member_id="member-1",
        employee_id="employee-1",
        snapshot_version="snap-1",
        policy={"enabled": True},
        bank_id="bank-a",
    )
    external = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"ok": True})
        )
    )
    app = _app(HindsightFacade(settings=settings, leases=leases, client=external, principal_repository=Mock(find_user=Mock(return_value=SimpleNamespace(status="active", roles=["member"]))), snapshot_service=_Snapshot({"enabled": True})))
    client = TestClient(app)
    leases.revoke(lease.lease_id)

    revoked = client.post(
        "/api/manager/hindsight/v1/default/banks/bank-a/memories/recall",
        headers={"Authorization": f"Bearer {lease.token}"},
        json={"query": "hello"},
    )
    assert revoked.status_code == 401

    query_bank = client.post(
        "/api/manager/hindsight/v1/default/banks/bank-a/memories/recall?bank_id=bank-b",
        headers={"Authorization": f"Bearer {lease.token}"},
        json={"query": "hello"},
    )
    assert query_bank.status_code == 403

    fresh = leases.issue(
        tenant_id="tenant-1",
        member_id="member-1",
        employee_id="employee-1",
        snapshot_version="snap-2",
        policy={"enabled": True},
        bank_id="bank-a",
    )
    body_bank = client.post(
        "/api/manager/hindsight/v1/default/banks/bank-a/memories/recall",
        headers={"Authorization": f"Bearer {fresh.token}"},
        json={"query": "hello", "nested": {"bank_id": "bank-b"}},
    )
    assert body_bank.status_code == 403


def test_facade_missing_lease_does_not_touch_upstream():
    leases = Mock()
    from manager_service.hindsight_lease_repository import HindsightLeaseUnauthorized
    leases.resolve.side_effect = HindsightLeaseUnauthorized("Hindsight lease is required")
    external = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200)))
    client = TestClient(_app(HindsightFacade(settings=_settings(), leases=leases, client=external)))
    response = client.post("/api/manager/hindsight/v1/default/banks/bank-a/memories/recall",
                           headers={"Authorization": "Bearer opaque"}, json={"query": "fixture"})
    assert response.status_code == 401
    leases.resolve.assert_called_once()


def test_facade_authorizes_using_lease_tenant_not_process_pin():
    leases = HindsightLeaseStore(token_factory=lambda: "opaque-lease")
    lease = leases.issue(tenant_id="tenant-a", member_id="member-a", employee_id="employee-a",
                         snapshot_version="snap-a", policy={"enabled": True, "allowed_operations": ["recall"]},
                         bank_id="bank-a")
    calls = []
    external = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: calls.append(request) or httpx.Response(200, json={"results": []})))
    principals = Mock(find_user=Mock(return_value=SimpleNamespace(status="active", roles=["member"])))
    client = TestClient(_app(HindsightFacade(
        settings=_settings(), leases=leases, client=external,
        principal_repository=principals, snapshot_service=_Snapshot({"enabled": True, "allowed_operations": ["recall"]}),
    )))
    response = client.post("/api/manager/hindsight/v1/default/banks/bank-a/memories/recall",
                           headers={"Authorization": f"Bearer {lease.token}"}, json={"query": "fixture"})
    assert response.status_code != 503
    assert principals.find_user.called
    ctx = principals.find_user.call_args.args[0]
    assert ctx.tenant_id == "tenant-a"


def test_facade_without_principal_dependency_or_with_failed_db_never_forwards():
    leases = HindsightLeaseStore()
    lease = leases.issue(tenant_id="tenant-1", member_id="member-1", employee_id="e", snapshot_version="s", policy={"enabled": True}, bank_id="bank-a")
    calls = []
    external = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: calls.append(request) or httpx.Response(200)))
    for principals in (None, Mock(find_user=Mock(side_effect=RuntimeError("private DB details")))):
        client = TestClient(_app(HindsightFacade(settings=_settings(), leases=leases, client=external, principal_repository=principals)))
        response = client.post("/api/manager/hindsight/v1/default/banks/bank-a/memories/recall", headers={"Authorization": "Bearer " + lease.token}, json={"query": "fixture"})
        assert response.status_code == 503
        assert "private DB details" not in response.text
    assert calls == []
