"""Real PostgreSQL/RLS coverage for Manager usage attribution and delivery."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import os
import uuid

import pytest

from manager_service.usage_analytics_service import UsageAnalyticsService
from manager_service.usage_audit_quota_repository import UsageAuditQuotaRepository
from manager_service.usage_audit_quota_service import UsageAuditQuotaService
from manager_service.usage_delivery_repository import UsageOperatorDeliveryRepository
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Forbidden

pytestmark = pytest.mark.integration

WS = datetime(2026, 9, 5, 8, tzinfo=timezone.utc)
WE = WS + timedelta(hours=2)
EMPLOYEE = str(uuid.uuid4())
OTHER_EMPLOYEE = str(uuid.uuid4())
MEMBER = str(uuid.uuid4())


def _payload(
    summary_id: str,
    *,
    tenant_id: str | None = None,
    member_id=MEMBER,
    employee_id=EMPLOYEE,
    unknown=False,
):
    return {
        "schema_version": "1",
        "summary_id": summary_id,
        "tenant_id": tenant_id,
        "member_id": member_id,
        "employee_id": employee_id,
        "window_start": WS,
        "window_end": WS + timedelta(hours=1),
        "run_count": 2,
        "token_total": 33,
        "cost_total": Decimal("0.125000000001"),
        "pricing_version": None if unknown else 1,
        "pricing_status": "unknown" if unknown else "known",
        "currency": "USD",
        "error_count": 0,
        "duration_seconds_total": 3,
        "prompt_count": 2,
        "settled_count": 2,
        "input_tokens": 10,
        "output_tokens": 20,
        "cache_tokens": 3,
        "duration_ms_total": 1234,
    }


def test_current_usage_requires_tenant_employee_and_member_grant(migrated_db, two_tenants):
    tenant_a, tenant_b = two_tenants
    member_ctx = TenantContext(tenant_id=tenant_a, user_id=MEMBER, roles=["member"])
    ctx_b = TenantContext(tenant_id=tenant_b, user_id=str(uuid.uuid4()), roles=["owner"])
    router = PgTenantRouter(migrated_db)
    with router.session(member_ctx) as session:
        session.execute(
            "INSERT INTO app_user (id, tenant_id, display_name, status, roles, department_ids) "
            "VALUES (%s::uuid, %s::uuid, 'member', 'active', ARRAY['member'], ARRAY[]::text[])",
            (MEMBER, tenant_a),
        )
        session.execute(
            "INSERT INTO employee (id, tenant_id, employee_slug, display_name) "
            "VALUES (%s::uuid, %s::uuid, 'granted', 'Granted')",
            (EMPLOYEE, tenant_a),
        )
        session.execute(
            "INSERT INTO member_grant (tenant_id, resource_type, resource_id, member_ids) "
            "VALUES (%s::uuid, 'expert', %s::uuid, ARRAY[%s::uuid])",
            (tenant_a, EMPLOYEE, MEMBER),
        )
    service = UsageAuditQuotaService(UsageAuditQuotaRepository(router))
    service.ingest_upload(member_ctx, {"usage": [_payload("granted", tenant_id=tenant_a)], "audits": []})

    with router.session(ctx_b) as session:
        session.execute(
            "INSERT INTO employee (id, tenant_id, employee_slug, display_name) "
            "VALUES (%s::uuid, %s::uuid, 'foreign', 'Foreign')",
            (OTHER_EMPLOYEE, tenant_b),
        )
    with pytest.raises(Forbidden):
        service.ingest_upload(
            member_ctx,
            {"usage": [_payload("foreign", tenant_id=tenant_a, employee_id=OTHER_EMPLOYEE)], "audits": []},
        )
    with router.session(member_ctx) as session:
        session.execute(
            "INSERT INTO employee (id, tenant_id, employee_slug, display_name) "
            "VALUES (%s::uuid, %s::uuid, 'ungrafted', 'Ungrafted')",
            (str(uuid.uuid4()), tenant_a),
        )
        ungrafted = session.execute(
            "SELECT id::text FROM employee WHERE employee_slug = 'ungrafted'"
        ).fetchone()[0]
    with pytest.raises(Forbidden):
        service.ingest_upload(
            member_ctx,
            {"usage": [_payload("ungrafted", tenant_id=tenant_a, employee_id=ungrafted)], "audits": []},
        )


def test_usage_statistics_delivery_and_rls_isolation(migrated_db, two_tenants, admin_url):
    tenant_a, tenant_b = two_tenants
    ctx_a = TenantContext(tenant_id=tenant_a, user_id=MEMBER, roles=["owner"])
    ctx_b = TenantContext(tenant_id=tenant_b, user_id=str(uuid.uuid4()), roles=["owner"])
    repo = UsageAuditQuotaRepository(PgTenantRouter(migrated_db))

    repo.upsert_usage_with_delivery(ctx_a, payload=_payload("known", unknown=False))
    repo.upsert_usage_with_delivery(ctx_a, payload=_payload("unknown", unknown=True, member_id=None, employee_id=None))
    # Delivery status is deliberately unrelated to the usage read projection.
    with PgTenantRouter(migrated_db).session(ctx_a) as session:
        session.execute(
            "UPDATE usage_operator_delivery SET status = 'sent', sent_at = now() "
            "WHERE summary_id = %s",
            ("known",),
        )

    stats = UsageAnalyticsService(repo).statistics(ctx_a, window_start=WS, window_end=WE)
    assert stats.summary_count == 2
    assert stats.execution_count == 4
    assert stats.token_total == 66
    assert stats.known_cost_total == Decimal("0.125000000001")
    assert stats.cost_total is None
    assert stats.task_count is None

    history = UsageAnalyticsService(repo).work_history(ctx_a, window_start=WS, window_end=WE)
    assert {item.summary_id for item in history} == {"known", "unknown"}
    legacy = next(item for item in history if item.summary_id == "unknown")
    assert legacy.member_id is None
    assert legacy.employee_id is None
    assert legacy.total_spending is None

    assert UsageAnalyticsService(repo).statistics(ctx_b, window_start=WS, window_end=WE).summary_count == 0
    assert UsageOperatorDeliveryRepository(PgTenantRouter(migrated_db)).list(ctx_b) == []

    # Migration replay is part of the contract: it must preserve both retained
    # aggregates and delivery receipts/statuses.
    from shared.db import apply_migrations
    apply_migrations(admin_url, app_rw_password=os.environ.get("APP_RW_PASSWORD"))
    assert UsageAnalyticsService(repo).statistics(ctx_a, window_start=WS, window_end=WE).execution_count == 4
    known_delivery = UsageOperatorDeliveryRepository(PgTenantRouter(migrated_db)).list(
        ctx_a, statuses=("sent",)
    )
    assert any(item.summary_id == "known" for item in known_delivery)
    import psycopg
    with psycopg.connect(admin_url, autocommit=True) as connection:
        assert connection.execute(
            "SELECT has_table_privilege('app_rw', 'usage_operator_delivery', 'DELETE')"
        ).fetchone()[0] is False
