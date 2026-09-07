from __future__ import annotations

from unittest.mock import Mock, patch

from fastapi import APIRouter
from fastapi.testclient import TestClient

from manager_service.in_app_notification_service import InAppNotificationService
from manager_service.routes_in_app_notification import build_in_app_notification_router
from shared.contracts.tenancy import TenantContext
from shared.app_factory import create_app
from shared.config import Settings
from tests.manager._auth_helper import make_inmem_verifier_and_signer


_TENANT = "11111111-1111-4111-8111-111111111111"
_OTHER = "22222222-2222-4222-8222-222222222222"


def _client():
    verifier, _signer = make_inmem_verifier_and_signer()
    app = create_app(
        Settings(tier="manager", service_name="notification-fixture", db_url="postgresql://fake/fake",
                 service_token="dev-service-token-placeholder"),
        APIRouter(),
    )
    app.include_router(build_in_app_notification_router(verifier))
    return TestClient(app)


def _body(tenant_id: str):
    return {"tenant_id": tenant_id, "org_id": "org-1", "message": "fixture notification"}


def test_operator_notification_is_phase_gated():
    client = _client()
    response = client.post("/api/manager/enterprise/notify", json=_body(_TENANT),
                           headers={"X-Service-Token": "dev-service-token-placeholder"})
    assert response.status_code == 503
    assert response.json()["code"] == "multitenancy_phase_pending"


def test_notification_service_uses_request_tenant_context():
    repo = Mock()
    service = InAppNotificationService(repo)
    ctx = TenantContext(tenant_id=_OTHER, user_id="member", roles=["member"])
    repo.list_all.return_value = []
    assert service.list_inbox(ctx) == []
    repo.list_all.assert_called_once_with(ctx)


def test_operator_notification_does_not_select_tenant_before_phase_gate():
    service = Mock()
    client = _client()
    with patch("manager_service.routes_in_app_notification._service", return_value=service):
        first = client.post("/api/manager/enterprise/notify", json=_body(_TENANT))
        second = client.post("/api/manager/enterprise/notify", json=_body(_OTHER))
    assert first.status_code == 503
    assert second.status_code == 503
    assert first.json()["code"] == "multitenancy_phase_pending"
    service.deliver_from_operation.assert_not_called()
