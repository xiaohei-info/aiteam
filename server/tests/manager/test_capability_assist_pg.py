"""Real PG/RLS for 「让模型帮我找」 usage (design 2026-11-20 §4.5, decision E): owner attribution, outbox, isolation."""

import uuid
from decimal import Decimal

import httpx
import psycopg
import pytest

from manager_service.billing_repository import BillingRepository
from manager_service.capability_assist import CapabilityAssistService, earliest_owner
from manager_service.usage_audit_quota_repository import (
    MANAGER_ASSIST_LABEL,
    UsageAuditQuotaRepository,
)
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from tests.manager.test_capability_assist import (
    PROPOSAL,
    _Operator,
    _Preview,
    _Relay,
    _request,
    chat,
)
from tests.manager.test_skill_import import _Fetch

pytestmark = pytest.mark.integration

def _seed_users(admin_url: str, tenant: str) -> tuple[str, str]:
    """Returns (expected owner, requesting admin); ids are fresh per run (fixture tenants are new each time)."""
    owner, admin = str(uuid.uuid4()), str(uuid.uuid4())
    rows = [
        (str(uuid.uuid4()), "disabled", ["owner"], "2026-01-01"),  # earliest, but no longer active
        (owner, "active", ["owner"], "2026-02-01"),
        (str(uuid.uuid4()), "active", ["owner", "enterprise_admin"], "2026-03-01"),
        (admin, "active", ["enterprise_admin"], "2025-12-01"),
    ]
    with psycopg.connect(admin_url, autocommit=True) as conn:
        for user_id, status, roles, created in rows:
            conn.execute(
                "INSERT INTO app_user (id, tenant_id, display_name, status, roles, created_at) VALUES (%s, %s, '', %s, %s, %s)",
                (user_id, tenant, status, roles, created),
            )
    return owner, admin


def test_assist_usage_is_billed_to_the_earliest_active_owner_with_outbox_and_rls(migrated_db, admin_url, two_tenants):
    router = PgTenantRouter(migrated_db)
    owner, admin = _seed_users(admin_url, two_tenants[0])
    ctx = TenantContext(tenant_id=two_tenants[0], user_id=admin, roles=["enterprise_admin"])
    other = TenantContext(tenant_id=two_tenants[1], user_id="x", roles=["owner"])
    assert earliest_owner(router, ctx) == owner
    assert earliest_owner(router, other) is None  # RLS: the other tenant's users are invisible

    usage = UsageAuditQuotaRepository(router)
    sent: list[dict] = []

    def sink(c: TenantContext, payload: dict) -> None:
        sent.append(payload)
        usage.upsert_usage_with_delivery(c, payload=payload)

    service = CapabilityAssistService(
        operator=_Operator(), import_service=_Preview(),
        usage_sink=sink,
        owner_lookup=lambda c: earliest_owner(router, c),
        http=httpx.Client(transport=httpx.MockTransport(_Relay([chat([PROPOSAL], tokens=(1000, 200, 0))]))),
        fetch=_Fetch({}), clawhub_base="https://clawhub.example.com", github_base="https://api.github.example.com",
    )
    service.run(ctx, _request())

    with psycopg.connect(admin_url, autocommit=True) as conn:
        row = conn.execute(
            "SELECT summary_id, member_id::text, employee_id, input_tokens, output_tokens, token_total, cost_total::text,"
            " pricing_status, run_count FROM usage_rollup WHERE tenant_id = %s AND summary_id LIKE 'manager-assist-%%'",
            (two_tenants[0],),
        ).fetchall()
        assert len(row) == 1
        summary_id, member_id, employee_id, input_tokens, output_tokens, total, cost, status, runs = row[0]
        assert (member_id, employee_id, input_tokens, output_tokens, total, runs) == (owner, None, 1000, 200, 1200, 1)
        assert (Decimal(cost), status) == (Decimal("0.0036"), "known")  # 1000·2 + 200·8 per million
        delivery = conn.execute(
            "SELECT member_id::text, employee_id, status, payload FROM usage_operator_delivery WHERE tenant_id = %s AND summary_id = %s",
            (two_tenants[0], summary_id),
        ).fetchone()
    assert delivery is not None and delivery[0] == owner and delivery[1] is None and delivery[2] == "pending"
    # Only the aggregate crosses to Operator: no member id, no content.
    assert set(delivery[3]) <= {"summary_id", "tenant_id", "employee_id", "window_start", "window_end", "run_count", "token_total",
                                "cost_total", "pricing_version", "pricing_status", "currency", "error_count", "duration_seconds_total"}
    assert all(item.summary_id != summary_id for item in usage.list_usage(other))

    # Usage page / billing: assist usage is its own 「管理工具」 row, apart from a legacy unattributed summary.
    legacy = {**sent[0], "summary_id": f"legacy-{uuid.uuid4()}", "member_id": None}
    usage.upsert_usage_with_delivery(ctx, payload=legacy)
    groups = {g["display_name"]: g for g in usage.aggregate_usage_statistics_groups(ctx, group_by="employee") if g["group_id"] is None}
    assert set(groups) == {MANAGER_ASSIST_LABEL, None} and groups[MANAGER_ASSIST_LABEL]["token_total"] == 1200
    by_member = {g["group_id"]: g for g in usage.aggregate_usage_statistics_groups(ctx, group_by="member")}
    assert by_member[owner]["token_total"] == 1200
    names = {r["record_id"]: r["employee_name"] for r in BillingRepository(router).list_usage_records(ctx, period="all")}
    assert sorted(names.values()) == ["未知员工", MANAGER_ASSIST_LABEL]
