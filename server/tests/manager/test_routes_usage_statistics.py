"""HTTP contract tests for additive Manager usage/work-statistics routes."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
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


def test_usage_upload_forwards_enterprise_mapping_and_keeps_report_hint_best_effort():
    fake = MagicMock()
    fake.ingest_upload.return_value = {"usage_ingested": 1, "audits_ingested": 0}
    with patch("manager_service.routes_usage_audit_quota._service", return_value=fake), \
         patch("manager_service.routes_usage_audit_quota._lookup_enterprise_id", return_value="enterprise-1"), \
         patch("manager_service.routes_usage_audit_quota._report_to_operator", side_effect=RuntimeError("operator offline")):
        response = _client().post(
            "/api/manager/usage/upload",
            json={"usage": [{"summary_id": "summary-1"}], "audits": []},
            headers=_headers(),
        )
    assert response.status_code == 200
    fake.ingest_upload.assert_called_once()
    assert fake.ingest_upload.call_args.kwargs["enterprise_id"] == "enterprise-1"
    assert response.json()["data"]["usage_ingested"] == 1


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


def test_operator_delivery_route_validates_status_and_serializes_receipts():
    row = SimpleNamespace(
        delivery_id="delivery-1", summary_id="summary-1", enterprise_id="enterprise-1",
        member_id="member-1", employee_id="employee-1", idempotency_key="usage-key",
        status="sent", attempts=1, next_attempt_at=None, last_error=None, claimed_at=None,
        created_at=datetime(2026, 9, 5, 8, tzinfo=timezone.utc),
        updated_at=datetime(2026, 9, 5, 8, tzinfo=timezone.utc), sent_at=datetime(2026, 9, 5, 8, tzinfo=timezone.utc),
    )
    repo = MagicMock()
    repo.list.return_value = [row]
    with patch("manager_service.routes_usage_audit_quota.UsageOperatorDeliveryRepository", return_value=repo):
        client = _client()
        response = client.get("/api/manager/usage/operator-deliveries?status=sent", headers=_headers())
        invalid = client.get("/api/manager/usage/operator-deliveries?status=broken", headers=_headers())
    assert response.status_code == 200
    assert response.json()["data"][0]["delivery_id"] == "delivery-1"
    repo.list.assert_called_once()
    assert invalid.status_code == 422


def test_usage_enterprise_lookup_handles_success_missing_config_and_failure(monkeypatch):
    from manager_service import routes_usage_audit_quota as module

    class Cursor:
        def fetchone(self):
            return ("enterprise-1",)

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def execute(self, sql, params):
            return Cursor()

    monkeypatch.setattr("psycopg.connect", lambda *args, **kwargs: Connection())
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(settings=SimpleNamespace(
        admin_db_url="postgresql://admin", operator_url="https://operator",
    ))))
    assert module._lookup_enterprise_id(request, TENANT) == "enterprise-1"
    request.app.state.settings = SimpleNamespace(admin_db_url=None, operator_url="https://operator")
    assert module._lookup_enterprise_id(request, TENANT) is None
    request.app.state.settings = SimpleNamespace(admin_db_url="postgresql://admin", operator_url="https://operator")
    monkeypatch.setattr("psycopg.connect", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("db unavailable")))
    assert module._lookup_enterprise_id(request, TENANT) is None


def test_usage_delivery_service_is_cached_and_report_is_best_effort():
    from manager_service import routes_usage_audit_quota as module

    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        settings=SimpleNamespace(db_url="postgresql://db", admin_db_url="postgresql://admin", operator_url="https://operator"),
    )))
    delivery = MagicMock()
    with patch.object(module, "build_usage_operator_delivery_service", return_value=delivery) as build:
        assert module._operator_delivery_service(request) is delivery
        assert module._operator_delivery_service(request) is delivery
    build.assert_called_once()
    module._report_to_operator(request, MagicMock(), SimpleNamespace(tenant_id=TENANT))
    delivery.deliver_due.assert_called_once()
