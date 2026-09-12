"""HTTP contract tests for additive Manager usage/work-statistics routes."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from manager_service.usage_analytics_schemas import UsageStatisticsOut, UsageWorkHistoryOut
from shared.config import Settings
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token


VERIFIER, SIGNER = make_inmem_verifier_and_signer()
TENANT = "tenant-1"


def _client():
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_usage_audit_quota import build_usage_audit_quota_router

    app = create_app(Settings(tier="manager", service_name="manager", db_url="postgresql://fake/fake"), manager_router)
    app.state._token_verifier = VERIFIER
    app.include_router(build_usage_audit_quota_router(VERIFIER))
    return TestClient(app)


def _headers():
    token = sign_inmem_token(SIGNER, TENANT, ["owner"], user_id="member-1")
    return {"Authorization": f"Bearer {token}"}


def test_usage_upload_binds_omitted_top_level_tenant_to_authenticated_context():
    fake = MagicMock()
    fake.ingest_upload.return_value = {"usage_ingested": 0, "audits_ingested": 0}
    with patch("manager_service.routes_usage_audit_quota._service", return_value=fake):
        response = _client().post(
            "/api/manager/usage/upload",
            json={"usage": [], "audits": []},
            headers=_headers(),
        )
    assert response.status_code == 200
    assert fake.ingest_upload.call_args.args[0].tenant_id == TENANT


def test_usage_upload_rejects_mismatched_top_level_tenant():
    fake = MagicMock()
    with patch("manager_service.routes_usage_audit_quota._service", return_value=fake):
        response = _client().post(
            "/api/manager/usage/upload",
            json={"tenant_id": "different-tenant", "usage": [], "audits": []},
            headers=_headers(),
        )
    assert response.status_code == 403
    fake.ingest_upload.assert_not_called()


def _stats():
    return UsageStatisticsOut(
        employee_id="employee-1", member_id="member-1",
        window_start=datetime(2026, 9, 5, 8, tzinfo=timezone.utc),
        window_end=datetime(2026, 9, 5, 9, tzinfo=timezone.utc),
        summary_count=1, execution_count=2, run_count=2, succeeded_count=2,
        token_total=10, token_spending=10, cost_total=Decimal("0.125000000001"),
        total_spending=Decimal("0.125000000001"), known_cost_total=Decimal("0.125000000001"),
        pricing_status="known",
    )


def _history():
    return UsageWorkHistoryOut(
        rollup_id="rollup-1", summary_id="summary-1", employee_id="employee-1",
        employee_display_name="员工", member_id="member-1", member_display_name="成员",
        window_start=datetime(2026, 9, 5, 8, tzinfo=timezone.utc),
        window_end=datetime(2026, 9, 5, 9, tzinfo=timezone.utc),
        execution_count=2, run_count=2, token_total=10, token_spending=10,
        cost_total=Decimal("0.125000000001"), total_spending=Decimal("0.125000000001"),
        known_cost_total=Decimal("0.125000000001"), pricing_status="known",
    )


def test_usage_statistics_and_work_history_routes_return_attribution_and_safe_metadata():
    fake = MagicMock()
    fake.statistics.return_value = _stats()
    fake.work_history.return_value = [_history()]
    with patch("manager_service.routes_usage_audit_quota._service", return_value=fake):
        client = _client()
        query = "employee_id=employee-1&member_id=member-1&window_start=2026-09-05T08:00:00Z&window_end=2026-09-05T09:00:00Z"
        stats = client.get(f"/api/manager/usage/statistics?{query}", headers=_headers())
        history = client.get(f"/api/manager/usage/work-history?{query}", headers=_headers())

    assert stats.status_code == 200
    assert stats.json()["data"]["member_id"] == "member-1"
    assert stats.json()["data"]["total_spending"] == "0.125000000001"
    assert history.status_code == 200
    assert history.json()["data"][0]["employee_id"] == "employee-1"
    assert "content" not in history.text
    fake.statistics.assert_called_once()


def test_new_usage_routes_require_authentication_and_management_role():
    client = _client()
    assert client.get("/api/manager/usage/statistics").status_code == 401
    assert client.get("/api/manager/usage/work-history").status_code == 401
    member = sign_inmem_token(SIGNER, TENANT, ["member"], user_id="member-1")
    headers = {"Authorization": f"Bearer {member}"}
    assert client.get("/api/manager/usage/statistics", headers=headers).status_code == 403
    assert client.get("/api/manager/usage/work-history", headers=headers).status_code == 403


def test_new_usage_routes_are_documented_with_window_and_error_contracts():
    spec = _client().get("/openapi.json").json()
    for path in ("/api/manager/usage/statistics", "/api/manager/usage/work-history"):
        operation = spec["paths"][path]["get"]
        assert operation["description"]
        assert {item["name"] for item in operation["parameters"]} >= {
            "employee_id", "member_id", "window_start", "window_end",
        }
        assert "422" in operation["responses"]
