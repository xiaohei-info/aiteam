from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from manager_service.active_principal import ManagerBindingMismatch
from manager_service.in_app_notification_service import InAppNotificationService
from manager_service.routes_in_app_notification import build_in_app_notification_router
from shared.contracts.tenancy import TenantContext
from shared.app_factory import create_app
from shared.config import Settings
from tests.manager._auth_helper import make_inmem_verifier_and_signer


_BOUND = "11111111-1111-4111-8111-111111111111"
_OTHER = "22222222-2222-4222-8222-222222222222"


def _client(bound_tenant_id: str | None = _BOUND):
    verifier, _signer = make_inmem_verifier_and_signer()
    app = create_app(
        Settings(tier="manager", service_name="notification-fixture", db_url="postgresql://fake/fake",
                 manager_tenant_id=bound_tenant_id, service_token="dev-service-token-placeholder"),
        APIRouter(),
    )
    app.include_router(build_in_app_notification_router(verifier))
    return TestClient(app)


def _body(tenant_id: str):
    return {"tenant_id": tenant_id, "org_id": "org-1", "message": "fixture notification"}


def test_operator_notification_fails_closed_when_manager_is_unbound():
    client = _client(None)
    response = client.post("/api/manager/enterprise/notify", json=_body(_BOUND),
                           headers={"X-Service-Token": "dev-service-token-placeholder"})
    assert response.status_code == 503
    assert response.json()["code"] == "manager_binding_required"


def test_notification_service_rechecks_bound_tenant_before_repository_io():
    repo = Mock()
    service = InAppNotificationService(repo, bound_tenant_id=_BOUND)
    with pytest.raises(ManagerBindingMismatch):
        service.list_inbox(TenantContext(tenant_id=_OTHER, user_id="member", roles=["member"]))
    assert repo.mock_calls == []


def test_operator_notification_must_match_bound_manager_tenant():
    service = Mock()
    service.deliver_from_operation.return_value = SimpleNamespace(
        notification_id="notification-1", org_id="org-1", message="fixture notification",
        notify_type="operation_announcement", severity="info", read=False,
        created_at=SimpleNamespace(isoformat=lambda: "2026-09-06T00:00:00+00:00"),
    )
    client = _client()
    with patch("manager_service.routes_in_app_notification._service", return_value=service):
        accepted = client.post("/api/manager/enterprise/notify", json=_body(_BOUND))
        rejected = client.post("/api/manager/enterprise/notify", json=_body(_OTHER))
    assert accepted.status_code == 200
    assert rejected.status_code == 503
    assert rejected.json()["code"] == "manager_binding_mismatch"
    assert service.deliver_from_operation.call_count == 1
