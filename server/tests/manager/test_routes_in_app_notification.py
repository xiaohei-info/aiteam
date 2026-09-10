from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import Mock, patch

from fastapi import APIRouter
from fastapi.testclient import TestClient

from manager_service.in_app_notification_repository import InAppNotificationRow
from manager_service.in_app_notification_service import (
    InAppNotificationService,
    build_in_app_notification_service,
)
from manager_service.routes_in_app_notification import build_in_app_notification_router
from shared.contracts.tenancy import TenantContext
from shared.app_factory import create_app
from shared.config import Settings
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token


_TENANT = "11111111-1111-4111-8111-111111111111"
_OTHER = "22222222-2222-4222-8222-222222222222"


def _client(*, aiteam_env="development", service_token="dev-service-token-placeholder", force_no_principal=False, onboarding_writes_enabled=False):
    verifier, _signer = make_inmem_verifier_and_signer()
    app = create_app(
        Settings(tier="manager", service_name="notification-fixture", db_url="postgresql://fake/fake",
                 service_token=service_token, aiteam_env=aiteam_env,
                 test_onboarding_writes_enabled=onboarding_writes_enabled),
        APIRouter(),
    )
    app.include_router(build_in_app_notification_router(verifier))
    if force_no_principal:
        from manager_service.service_ingress import require_operator_service_principal
        app.dependency_overrides[require_operator_service_principal] = lambda: None
    return TestClient(app)


def _body(tenant_id: str):
    return {"tenant_id": tenant_id, "org_id": "org-1", "message": "fixture notification"}


def test_operator_notification_is_phase_gated():
    client = _client()
    response = client.post("/api/manager/enterprise/notify", json=_body(_TENANT),
                           headers={"X-Service-Token": "dev-service-token-placeholder", "Idempotency-Key": "notify-phase-1"})
    assert response.status_code == 503
    assert response.json()["code"] == "multitenancy_phase_pending"


def test_notification_service_uses_request_tenant_context():
    repo = Mock()
    service = InAppNotificationService(repo)
    ctx = TenantContext(tenant_id=_OTHER, user_id="member", roles=["member"])
    repo.list_all.return_value = []
    assert service.list_inbox(ctx) == []
    repo.list_all.assert_called_once_with(ctx)


def test_build_notification_service_returns_service():
    repo = Mock()
    assert isinstance(build_in_app_notification_service(repo), InAppNotificationService)


def test_operator_notification_delivers_when_phase_opens(monkeypatch):
    repo = Mock()
    repo.add_idempotent.return_value = InAppNotificationRow(
        notification_id="n-1",
        tenant_id=_TENANT,
        org_id="org-1",
        message="fixture notification",
        notify_type="announcement",
        severity="info",
        read=False,
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    service = InAppNotificationService(repo)
    monkeypatch.setenv("AITEAM_TEST_ENABLE_ONBOARDING_WRITES", "true")
    client = _client(aiteam_env="test", service_token="test-service-token", force_no_principal=True, onboarding_writes_enabled=True)
    with patch("manager_service.routes_in_app_notification.OperatorTenantBindingRepository.require_exact"), \
            patch("manager_service.routes_in_app_notification._service", return_value=service):
        response = client.post(
            "/api/manager/enterprise/notify",
            json=_body(_TENANT),
            headers={"X-Service-Token": "test-service-token", "Idempotency-Key": "notify-test-1"},
        )

    assert response.status_code == 200
    assert response.json()["data"]["notification_id"] == "n-1"
    repo.add_idempotent.assert_called_once()


def test_inbox_lists_for_authenticated_tenant():
    verifier, signer = make_inmem_verifier_and_signer()
    app = create_app(
        Settings(tier="manager", service_name="notification-inbox-fixture", db_url="postgresql://fake/fake",
                 service_token="dev-service-token-placeholder"),
        APIRouter(),
    )
    app.include_router(build_in_app_notification_router(verifier))
    repo = Mock()
    repo.list_all.return_value = [InAppNotificationRow(
        notification_id="n-2",
        tenant_id=_TENANT,
        org_id="org-1",
        message="hello",
        notify_type="announcement",
        severity="info",
        read=False,
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )]
    app.state._in_app_notification_repo = repo
    client = TestClient(app)
    token = sign_inmem_token(signer, _TENANT, ["enterprise_admin"], user_id="member-1")
    response = client.get(
        "/api/manager/inbox",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json()["data"][0]["notification_id"] == "n-2"
    repo.list_all.assert_called_once()


def test_operator_notification_requires_idempotency_key_when_phase_is_open():
    service = Mock()
    client = _client()
    with patch("manager_service.routes_in_app_notification.require_control_plane_writes_ready"), \
            patch("manager_service.routes_in_app_notification._service", return_value=service):
        response = client.post(
            "/api/manager/enterprise/notify",
            json=_body(_TENANT),
            headers={"X-Service-Token": "dev-service-token-placeholder"},
        )
    assert response.status_code == 422
    service.deliver_from_operation.assert_not_called()


def test_operator_notification_does_not_select_tenant_before_phase_gate():
    service = Mock()
    client = _client()
    with patch("manager_service.routes_in_app_notification._service", return_value=service):
        first = client.post("/api/manager/enterprise/notify", json=_body(_TENANT), headers={"Idempotency-Key": "notify-gate-1"})
        second = client.post("/api/manager/enterprise/notify", json=_body(_OTHER), headers={"Idempotency-Key": "notify-gate-2"})
    assert first.status_code == 503
    assert second.status_code == 503
    assert first.json()["code"] == "multitenancy_phase_pending"
    service.deliver_from_operation.assert_not_called()
