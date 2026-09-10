from __future__ import annotations

import uuid

import psycopg
import pytest

from manager_service.idempotency_repository import ManagerIdempotencyRepository
from manager_service.in_app_notification_repository import InAppNotificationRepository
from manager_service.onboarding_repository import OperatorTenantBindingRepository
from shared.db import PgTenantRouter
from shared.errors import Conflict


@pytest.mark.integration
def test_manager_f01_retries_same_key_without_rebinding(pg_admin_url, migrated_pg):
    tenant_id = str(uuid.uuid4())
    enterprise_id = str(uuid.uuid4())
    slug = f"onboarding_{uuid.uuid4().hex[:10]}"
    key = f"f01-{uuid.uuid4().hex}"
    principal = {
        "kid": "operator-integration-kid",
        "iss": "https://operator.integration.test",
        "sub": "operator-service",
        "aud": "manager-service",
        "deployment_id": "operator-integration-deployment",
        "origin": "https://operator.integration.test",
    }
    repo = OperatorTenantBindingRepository(pg_admin_url)
    try:
        assert repo.ensure_registry_and_binding(
            tenant_id=tenant_id,
            enterprise_id=enterprise_id,
            enterprise_slug=slug,
            enterprise_code="onboarding-code",
            principal=principal,
            idempotency_key=key,
            request_fingerprint="fingerprint-a",
        ) is True
        assert repo.ensure_registry_and_binding(
            tenant_id=tenant_id,
            enterprise_id=enterprise_id,
            enterprise_slug=slug,
            enterprise_code="onboarding-code",
            principal=principal,
            idempotency_key=key,
            request_fingerprint="fingerprint-a",
        ) is False
        with pytest.raises(Conflict, match="Idempotency-Key"):
            repo.ensure_registry_and_binding(
                tenant_id=tenant_id,
                enterprise_id=enterprise_id,
                enterprise_slug=slug,
                enterprise_code="onboarding-code",
                principal=principal,
                idempotency_key=key,
                request_fingerprint="fingerprint-b",
            )
    finally:
        import psycopg

        with psycopg.connect(pg_admin_url, autocommit=True) as conn:
            conn.execute("DELETE FROM manager_onboarding_receipt WHERE idempotency_key=%s", (key,))
            conn.execute("DELETE FROM operator_tenant_binding WHERE tenant_id=%s", (tenant_id,))
            conn.execute("DELETE FROM tenant_registry WHERE tenant_id=%s", (tenant_id,))


@pytest.mark.integration
def test_manager_http_onboarding_opt_in_runs_f01_f02_f17_idempotently(migrated_pg, pg_admin_url):
    import os
    from fastapi.testclient import TestClient
    from manager_service import app as manager_module

    manager_app = manager_module.app
    old_settings = manager_app.state.settings
    manager_app.state.settings = old_settings.model_copy(update={"aiteam_env": "test", "test_onboarding_writes_enabled": True})
    tenant_id = str(uuid.uuid4())
    enterprise_id = str(uuid.uuid4())
    slug = f"http_onboarding_{uuid.uuid4().hex[:10]}"
    headers = {"X-Service-Token": os.getenv("SERVICE_TOKEN", "test-service-token")}
    f01_key = f"http-f01-{uuid.uuid4().hex}"
    f02_key = f"http-f02-{uuid.uuid4().hex}"
    f17_key = f"http-f17-{uuid.uuid4().hex}"
    try:
        with TestClient(manager_app) as client:
            f01_body = {"enterprise_id": enterprise_id, "tenant_id": tenant_id, "enterprise_name": "HTTP onboarding", "enterprise_code": slug}
            first = client.post("/api/manager/tenants", json=f01_body, headers={**headers, "Idempotency-Key": f01_key})
            replay = client.post("/api/manager/tenants", json=f01_body, headers={**headers, "Idempotency-Key": f01_key})
            assert first.status_code == replay.status_code == 201
            f02_body = {"tenant_id": tenant_id, "owner_phone": f"138{uuid.uuid4().int % 10_000_000:07d}", "bootstrap_secret": "Boot!1-http-test", "must_reset": True}
            first = client.post("/api/manager/owner-bootstrap", json=f02_body, headers={**headers, "Idempotency-Key": f02_key})
            replay = client.post("/api/manager/owner-bootstrap", json=f02_body, headers={**headers, "Idempotency-Key": f02_key})
            assert first.status_code == replay.status_code == 201
            f17_body = {"tenant_id": tenant_id, "org_id": enterprise_id, "message": "HTTP notification", "notify_type": "operation_announcement", "severity": "info"}
            first = client.post("/api/manager/enterprise/notify", json=f17_body, headers={**headers, "Idempotency-Key": f17_key})
            replay = client.post("/api/manager/enterprise/notify", json=f17_body, headers={**headers, "Idempotency-Key": f17_key})
            assert first.status_code == replay.status_code == 200
            conflict = client.post("/api/manager/enterprise/notify", json={**f17_body, "message": "different"}, headers={**headers, "Idempotency-Key": f17_key})
            assert conflict.status_code == 409
    finally:
        manager_app.state.settings = old_settings
        with psycopg.connect(pg_admin_url, autocommit=True) as conn:
            conn.execute("DELETE FROM manager_idempotency_receipt WHERE tenant_id=%s", (tenant_id,))
            conn.execute("DELETE FROM manager_onboarding_receipt WHERE tenant_id=%s", (tenant_id,))
            conn.execute("DELETE FROM in_app_notification WHERE tenant_id=%s", (tenant_id,))
            conn.execute("DELETE FROM auth_identity WHERE tenant_id=%s", (tenant_id,))
            conn.execute("DELETE FROM app_user WHERE tenant_id=%s", (tenant_id,))
            conn.execute("DELETE FROM operator_tenant_binding WHERE tenant_id=%s", (tenant_id,))
            conn.execute("DELETE FROM tenant_registry WHERE tenant_id=%s", (tenant_id,))


@pytest.mark.integration
def test_manager_f02_f17_receipts_replay_without_retaining_notification_body(tenant_scope, migrated_pg):
    ctx = tenant_scope.context(roles=["owner"], user_id="service")
    repository = ManagerIdempotencyRepository(PgTenantRouter(migrated_pg))
    calls = []
    first = repository.execute(
        ctx,
        operation="owner-bootstrap",
        idempotency_key="f02-integration",
        request_fingerprint="f02-fingerprint",
        effect=lambda _session: calls.append("effect") or {"tenant_id": ctx.tenant_id, "user_id": "owner-1"},
        status_code=201,
    )
    replay = repository.execute(
        ctx,
        operation="owner-bootstrap",
        idempotency_key="f02-integration",
        request_fingerprint="f02-fingerprint",
        effect=lambda _session: calls.append("replayed"),
        status_code=201,
    )
    assert first.replayed is False and replay.replayed is True
    assert calls == ["effect"]

    notifications = InAppNotificationRepository(PgTenantRouter(migrated_pg))
    message = "private F17 body"
    notification = notifications.add_idempotent(
        ctx,
        org_id="org-1",
        message=message,
        notify_type="operation_announcement",
        severity="info",
        idempotency_key="f17-integration",
        request_fingerprint="f17-fingerprint",
    )
    assert notification.message == message
    import psycopg

    with psycopg.connect(tenant_scope.admin_url, autocommit=True) as conn:
        receipt = conn.execute(
            "SELECT response_body::text FROM manager_idempotency_receipt WHERE tenant_id=%s AND operation=%s AND idempotency_key=%s",
            (ctx.tenant_id, "enterprise-notification", "f17-integration"),
        ).fetchone()
    assert receipt is not None
    assert message not in str(receipt[0])
