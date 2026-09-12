"""Manager usage read-scope and current employee attribution security tests."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from manager_service.schemas import UsageAggregateOut
from shared.config import Settings
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden, ValidationProblem
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token

VERIFIER, SIGNER = make_inmem_verifier_and_signer()
TENANT = "tenant-1"
MEMBER = str(uuid4())
OTHER_MEMBER = str(uuid4())


def _client():
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_usage_audit_quota import build_usage_audit_quota_router

    app = create_app(Settings(tier="manager", service_name="manager", db_url="postgresql://fake/fake"), manager_router)
    app.state._token_verifier = VERIFIER
    app.include_router(build_usage_audit_quota_router(VERIFIER))
    return TestClient(app)


def _headers(*, roles=("member",), user_id=MEMBER):
    token = sign_inmem_token(SIGNER, TENANT, list(roles), user_id=user_id)
    return {"Authorization": f"Bearer {token}"}


def _service():
    service = MagicMock()
    service.list_usage.return_value = []
    service.list_audits.return_value = []
    service.aggregate_usage.return_value = UsageAggregateOut(
        rollup_count=0, run_count=0, token_total=0, cost_total=Decimal("0"),
        error_count=0, duration_seconds_total=0,
    )
    return service


def test_member_usage_reads_are_scoped_to_own_member():
    service = _service()
    with patch("manager_service.routes_usage_audit_quota._service", return_value=service):
        client = _client()
        assert client.get("/api/manager/usage/rollup", headers=_headers()).status_code == 200
        assert client.get(
            f"/api/manager/usage/rollup?member_id={MEMBER}"
            "&window_start=2026-09-05T08:00:00Z&window_end=2026-09-05T09:00:00Z",
            headers=_headers(),
        ).status_code == 200
        assert client.get(
            f"/api/manager/usage/rollup/list?member_id={MEMBER}", headers=_headers()
        ).status_code == 200
        assert client.get("/api/manager/audits", headers=_headers()).status_code == 200
    assert service.aggregate_usage.call_args.kwargs == {
        "window_start": datetime(2026, 9, 5, 8, tzinfo=timezone.utc),
        "window_end": datetime(2026, 9, 5, 9, tzinfo=timezone.utc),
        "member_id": MEMBER,
    }
    assert service.list_usage.call_args.kwargs == {"member_id": MEMBER}
    assert service.list_audits.call_args.kwargs == {"actor": MEMBER}


def test_member_cannot_read_another_member_usage_or_audits():
    service = _service()
    with patch("manager_service.routes_usage_audit_quota._service", return_value=service):
        client = _client()
        for path in (
            f"/api/manager/usage/rollup?member_id={OTHER_MEMBER}",
            f"/api/manager/usage/rollup/list?member_id={OTHER_MEMBER}",
            f"/api/manager/audits?member_id={OTHER_MEMBER}",
        ):
            response = client.get(path, headers=_headers())
            assert response.status_code == 403
    service.list_usage.assert_not_called()
    service.list_audits.assert_not_called()


def test_admin_usage_reads_remain_tenant_wide():
    service = _service()
    with patch("manager_service.routes_usage_audit_quota._service", return_value=service):
        client = _client()
        response = client.get("/api/manager/usage/rollup/list", headers=_headers(roles=("owner",)))
        assert response.status_code == 200
        response = client.get("/api/manager/audits", headers=_headers(roles=("enterprise_admin",)))
        assert response.status_code == 200
    service.list_usage.assert_called_once_with(TenantContext(
        tenant_id=TENANT, user_id=MEMBER, roles=["owner"], enterprise_id=None,
    ), member_id=None)


def test_audit_summaries_use_bounded_allowlisted_opaque_fields():
    from manager_service.usage_audit_quota_service import UsageAuditQuotaService

    captured = []

    class Repo:
        def upsert_audit(self, ctx, *, payload):
            captured.append(payload)
            return object()

    service = UsageAuditQuotaService(Repo())
    valid = {
        "summary_id": "audit-1", "tenant_id": TENANT, "actor": MEMBER,
        "action": "unauthorized_attempt", "resource_type": "expert",
        "resource_id": str(uuid4()), "occurred_at": "2026-09-05T08:00:00Z",
    }
    with pytest.raises(ValidationProblem):
        service.ingest_upload(TenantContext(tenant_id=TENANT, user_id=MEMBER, roles=["owner"]), {
            "usage": [], "audits": [{**valid, "detail": "free-form prompt/result"}],
        })
    with pytest.raises(ValidationProblem):
        service.ingest_upload(TenantContext(tenant_id=TENANT, user_id=MEMBER, roles=["owner"]), {
            "usage": [], "audits": [{**valid, "actor": "member with free text"}],
        })
    service.ingest_upload(TenantContext(tenant_id=TENANT, user_id=MEMBER, roles=["owner"]), {
        "usage": [], "audits": [valid],
    })
    assert captured[0]["actor"] == MEMBER


def test_employee_attribution_validation_fails_closed_for_real_repository_seam():
    from manager_service.usage_audit_quota_service import UsageAuditQuotaService

    class Repo:
        def employee_exists(self, ctx, *, employee_id):
            return False

        def employee_granted_to_member(self, ctx, *, employee_id, member_id):
            return False

    service = UsageAuditQuotaService(Repo())
    with pytest.raises(Forbidden):
        service.ingest_upload(TenantContext(tenant_id=TENANT, user_id=MEMBER, roles=["member"]), {
            "usage": [{
                "schema_version": "1", "summary_id": "current", "tenant_id": TENANT,
                "member_id": MEMBER, "employee_id": str(uuid4()),
                "window_start": "2026-09-05T08:00:00Z", "window_end": "2026-09-05T09:00:00Z",
                "prompt_count": 1, "settled_count": 1, "error_count": 0,
                "input_tokens": 1, "output_tokens": 1, "cache_tokens": 0,
                "cost_minor": 0, "currency": "USD", "duration_ms_total": 1,
                "pricing_version": 1, "pricing_status": "known", "run_count": 1,
                "token_total": 2, "cost_total": "0.01", "duration_seconds_total": 1,
            }], "audits": [],
        })
