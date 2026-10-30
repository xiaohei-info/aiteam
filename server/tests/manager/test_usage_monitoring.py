"""Enterprise usage monitoring: read-only role access and grouped statistics."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from manager_service.usage_analytics_schemas import (
    UsageStatisticsGroupedOut,
    UsageStatisticsGroupOut,
    UsageStatisticsOut,
)
from manager_service.usage_analytics_service import UsageAnalyticsService
from manager_service.usage_audit_quota_repository import UsageAuditQuotaRepository
from shared.config import Settings
from shared.contracts.tenancy import TenantContext
from shared.errors import ValidationProblem
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from tests.manager._fake_router import FakeCursor, FakeRouter


VERIFIER, SIGNER = make_inmem_verifier_and_signer()
TENANT = "tenant-1"
CTX = TenantContext(
    tenant_id="11111111-1111-1111-1111-111111111111",
    user_id="22222222-2222-2222-2222-222222222222",
    roles=["enterprise_admin"],
)
EMPLOYEE = "33333333-3333-3333-3333-333333333333"
WS = datetime(2026, 10, 23, 16, tzinfo=timezone.utc)
WE = WS + timedelta(days=7)


def _client(router_builder):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router

    app = create_app(Settings(tier="manager", service_name="manager", db_url="postgresql://fake/fake"), manager_router)
    app.state._token_verifier = VERIFIER
    app.include_router(router_builder(VERIFIER))
    return TestClient(app)


def _headers(role: str):
    return {"Authorization": "Bearer " + sign_inmem_token(SIGNER, TENANT, [role], user_id="member-1")}


def _billing_service():
    svc = MagicMock()
    svc.get_usage_overview.return_value = {
        "period": "month", "total_tokens": 0, "total_cost": None, "trend": [], "ranking": [],
    }
    svc.list_usage_records.return_value = []
    return svc


# ---- billing usage reads: enterprise_admin added, billing mutations unchanged ----


@pytest.mark.parametrize("role", ["owner", "finance_admin", "enterprise_admin"])
def test_billing_usage_reads_allow_owner_finance_and_enterprise_admin(role):
    from manager_service.routes_billing import build_billing_router

    with patch("manager_service.routes_billing._service", return_value=_billing_service()):
        client = _client(build_billing_router)
        assert client.get("/api/manager/billing/usage/overview", headers=_headers(role)).status_code == 200
        assert client.get("/api/manager/billing/usage/records", headers=_headers(role)).status_code == 200


def test_billing_usage_reads_deny_member():
    from manager_service.routes_billing import build_billing_router

    svc = _billing_service()
    with patch("manager_service.routes_billing._service", return_value=svc):
        client = _client(build_billing_router)
        assert client.get("/api/manager/billing/usage/overview", headers=_headers("member")).status_code == 403
        assert client.get("/api/manager/billing/usage/records", headers=_headers("member")).status_code == 403
    svc.get_usage_overview.assert_not_called()
    svc.list_usage_records.assert_not_called()


def test_enterprise_admin_still_cannot_read_balance_or_recharge():
    from manager_service.routes_billing import build_billing_router

    svc = MagicMock()
    with patch("manager_service.routes_billing._service", return_value=svc):
        client = _client(build_billing_router)
        headers = _headers("enterprise_admin")
        assert client.get("/api/manager/billing/balance", headers=headers).status_code == 403
        assert client.get("/api/manager/billing/recharges", headers=headers).status_code == 403
        created = client.post(
            "/api/manager/billing/recharges",
            json={"amount": 10, "payment_method": "wechat_pay"},
            headers=headers,
        )
        assert created.status_code == 403
    svc.get_balance.assert_not_called()
    svc.create_recharge.assert_not_called()


# ---- /usage/statistics group_by ----


def _grouped_stats():
    return UsageStatisticsGroupedOut(
        token_total=15, execution_count=3, summary_count=2, pricing_status="partial",
        known_cost_total=Decimal("0.5"), group_by="employee",
        groups=[
            UsageStatisticsGroupOut(
                group_id=EMPLOYEE, display_name="研究员", token_total=10, execution_count=2,
                cost_total=Decimal("0.5"), known_cost_total=Decimal("0.5"), pricing_status="known",
            ),
            UsageStatisticsGroupOut(
                group_id=None, display_name="未知员工", token_total=5, execution_count=1,
                pricing_status="unknown", unpriced_execution_count=1,
            ),
        ],
    )


@pytest.mark.parametrize("role", ["owner", "finance_admin", "enterprise_admin"])
def test_statistics_group_by_returns_groups_for_usage_admins(role):
    from manager_service.routes_usage_audit_quota import build_usage_audit_quota_router

    fake = MagicMock()
    fake.statistics.return_value = _grouped_stats()
    with patch("manager_service.routes_usage_audit_quota._service", return_value=fake):
        response = _client(build_usage_audit_quota_router).get(
            "/api/manager/usage/statistics?group_by=employee"
            "&window_start=2026-10-23T16:00:00Z&window_end=2026-10-30T16:00:00Z",
            headers=_headers(role),
        )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["group_by"] == "employee"
    assert [group["group_id"] for group in data["groups"]] == [EMPLOYEE, None]
    assert data["groups"][0]["cost_total"] == "0.5"
    assert data["groups"][1]["cost_total"] is None
    assert data["groups"][1]["pricing_status"] == "unknown"
    assert fake.statistics.call_args.kwargs["group_by"] == "employee"


def test_statistics_without_group_by_keeps_original_shape():
    from manager_service.routes_usage_audit_quota import build_usage_audit_quota_router

    fake = MagicMock()
    fake.statistics.return_value = UsageStatisticsOut(token_total=1)
    with patch("manager_service.routes_usage_audit_quota._service", return_value=fake):
        response = _client(build_usage_audit_quota_router).get(
            "/api/manager/usage/statistics", headers=_headers("enterprise_admin"),
        )
    assert response.status_code == 200
    assert "groups" not in response.json()["data"]
    assert "group_by" not in response.json()["data"]
    assert "group_by" not in fake.statistics.call_args.kwargs


def test_statistics_group_by_rejects_unknown_value_and_member_role():
    from manager_service.routes_usage_audit_quota import build_usage_audit_quota_router

    fake = MagicMock()
    with patch("manager_service.routes_usage_audit_quota._service", return_value=fake):
        client = _client(build_usage_audit_quota_router)
        invalid = client.get("/api/manager/usage/statistics?group_by=department", headers=_headers("owner"))
        member = client.get("/api/manager/usage/statistics?group_by=member", headers=_headers("member"))
    assert invalid.status_code == 422
    assert member.status_code == 403
    fake.statistics.assert_not_called()


def test_statistics_group_by_is_documented_as_enum():
    from manager_service.routes_usage_audit_quota import build_usage_audit_quota_router

    spec = _client(build_usage_audit_quota_router).get("/openapi.json").json()
    operation = spec["paths"]["/api/manager/usage/statistics"]["get"]
    parameter = next(item for item in operation["parameters"] if item["name"] == "group_by")
    assert parameter["description"]
    assert "数据归属" in operation["description"]
    assert '"employee"' in str(parameter["schema"]).replace("'", '"')


# ---- service ----


class _GroupRepo:
    def __init__(self) -> None:
        self.group_calls: list[dict] = []

    def aggregate_usage_statistics(self, ctx, **filters):
        return {
            "summary_count": 3, "execution_count": 4, "run_count": 4, "settled_count": 3,
            "error_count": 1, "token_total": 30, "known_cost_total": Decimal("0.2"),
            "unknown_pricing_runs": 1, "unknown_summary_count": 1,
        }

    def aggregate_usage_statistics_groups(self, ctx, **filters):
        self.group_calls.append(filters)
        return [
            {
                "group_id": EMPLOYEE, "display_name": "研究员", "summary_count": 2,
                "execution_count": 3, "settled_count": 3, "token_total": 20,
                "known_cost_total": Decimal("0.2"), "unknown_summary_count": 0,
            },
            {
                "group_id": "44444444-4444-4444-4444-444444444444", "display_name": None,
                "summary_count": 0, "token_total": 0,
            },
            {
                "group_id": None, "display_name": None, "summary_count": 1, "execution_count": 1,
                "error_count": 1, "token_total": 10, "known_cost_total": Decimal("0"),
                "unknown_pricing_runs": 1, "unknown_summary_count": 1,
            },
        ]


def test_service_group_by_derives_per_group_pricing_and_name_fallbacks():
    repo = _GroupRepo()
    result = UsageAnalyticsService(repo).statistics(
        CTX, window_start=WS, window_end=WE, group_by="employee",
    )

    assert isinstance(result, UsageStatisticsGroupedOut)
    assert result.pricing_status == "partial" and result.cost_total is None
    assert repo.group_calls == [{
        "group_by": "employee", "employee_id": None, "member_id": None,
        "window_start": WS, "window_end": WE,
    }]
    known, deleted, unknown = result.groups
    assert (known.display_name, known.cost_total, known.pricing_status) == ("研究员", Decimal("0.2"), "known")
    assert deleted.display_name == "已删除员工"
    assert unknown.display_name == "未知员工"
    assert unknown.cost_total is None and unknown.known_cost_total is None
    assert unknown.pricing_status == "unknown" and unknown.unpriced_execution_count == 1
    assert sum(group.token_total for group in result.groups) == result.token_total


def test_service_member_group_names_and_invalid_group_by():
    repo = _GroupRepo()
    result = UsageAnalyticsService(repo).statistics(CTX, group_by="member")
    assert [group.display_name for group in result.groups][1:] == ["已删除成员", "未知成员"]
    with pytest.raises(ValidationProblem):
        UsageAnalyticsService(repo).statistics(CTX, group_by="department")


def test_service_without_group_by_does_not_query_groups():
    repo = _GroupRepo()
    result = UsageAnalyticsService(repo).statistics(CTX)
    assert type(result) is UsageStatisticsOut
    assert repo.group_calls == []


# ---- repository ----


def _aggregate_row(token_total: int) -> tuple:
    return (1, 2, 2, 2, 2, 0, 5, 5, 0, token_total, 10, 0, Decimal("0.1"), 0, 0, 0)


def test_repository_groups_by_allowlisted_column_with_same_scope_params():
    router = FakeRouter().queue(FakeCursor(fetchall=[
        (EMPLOYEE, "研究员", *_aggregate_row(10)),
        (None, None, *_aggregate_row(3)),
    ]))
    rows = UsageAuditQuotaRepository(router).aggregate_usage_statistics_groups(
        CTX, group_by="employee", member_id=CTX.user_id, window_start=WS, window_end=WE,
    )

    sql, params = router.executed[0]
    assert "LEFT JOIN employee AS n ON n.id = u.employee_id" in sql
    assert "GROUP BY u.employee_id" in sql
    assert "ORDER BY SUM(u.token_total) DESC" in sql
    assert params[:2] == (WS, WE)
    assert str(params[2]) == CTX.user_id
    assert rows[0]["group_id"] == EMPLOYEE and rows[0]["display_name"] == "研究员"
    assert rows[0]["token_total"] == 10 and rows[0]["known_cost_total"] == Decimal("0.1")
    assert rows[1]["group_id"] is None and rows[1]["display_name"] is None


def test_repository_member_groups_join_app_user_and_totals_share_projection():
    router = FakeRouter().queue_many(
        FakeCursor(fetchall=[]),
        FakeCursor(fetchone=_aggregate_row(7)),
    )
    repo = UsageAuditQuotaRepository(router)
    assert repo.aggregate_usage_statistics_groups(CTX, group_by="member") == []
    totals = repo.aggregate_usage_statistics(CTX)

    assert "LEFT JOIN app_user AS n ON n.id = u.member_id" in router.executed[0][0]
    assert "GROUP BY u.member_id" in router.executed[0][0]
    assert "GROUP BY" not in router.executed[1][0]
    assert totals["token_total"] == 7
