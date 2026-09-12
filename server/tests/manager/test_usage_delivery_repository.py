"""Repository contract tests for durable Manager usage delivery receipts."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

import pytest

from manager_service.usage_audit_quota_repository import UsageAuditQuotaRepository
from manager_service.usage_delivery_repository import (
    MAX_DELIVERY_ATTEMPTS,
    UsageOperatorDeliveryRepository,
    _payload_dict,
    _row_to_delivery,
    _to_uuid,
    operator_summary_payload,
)
from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict
from tests.manager._fake_router import FakeCursor, FakeRouter


TENANT = "11111111-1111-1111-1111-111111111111"
EMPLOYEE = "22222222-2222-2222-2222-222222222222"
MEMBER = "33333333-3333-3333-3333-333333333333"
CTX = TenantContext(tenant_id=TENANT, user_id=MEMBER, roles=["owner"])
WS = datetime(2026, 9, 5, 8, tzinfo=timezone.utc)
WE = datetime(2026, 9, 5, 9, tzinfo=timezone.utc)


def usage_row():
    return (
        "44444444-4444-4444-4444-444444444444", TENANT, "summary-1", EMPLOYEE,
        WS, WE, 2, 33, Decimal("0.125000000001"), 1, "known", "USD", 0, 3, WS,
        MEMBER, 2, 1, 10, 20, 3, 1234,
    )


def delivery_row():
    return (
        "55555555-5555-5555-5555-555555555555", TENANT,
        "66666666-6666-6666-6666-666666666666", "summary-1", "usage-key",
        {"summary_id": "summary-1", "tenant_id": TENANT, "employee_id": EMPLOYEE,
         "window_start": WS.isoformat(), "window_end": WE.isoformat(), "run_count": 2,
         "token_total": 33, "cost_total": "0.125000000001", "currency": "USD",
         "pricing_version": 1, "pricing_status": "known", "error_count": 0,
         "duration_seconds_total": 3},
        "pending", 0, WS, None, None, None, WS, WS, None, MEMBER, EMPLOYEE,
    )


def test_delivery_projection_normalizes_known_null_cost_to_unknown():
    payload = operator_summary_payload({
        "summary_id": "summary-1", "employee_id": EMPLOYEE,
        "window_start": WS, "window_end": WE, "pricing_status": "known",
        "cost_total": None, "pricing_version": 1,
    }, tenant_id=TENANT)
    assert payload["pricing_status"] == "unknown"
    assert payload["pricing_version"] is None
    assert payload["cost_total"] is None


def test_usage_attribution_conflict_aborts_same_summary_replay():
    router = FakeRouter().queue(FakeCursor(fetchone=None))
    payload = {
        "summary_id": "summary-1", "employee_id": EMPLOYEE, "member_id": MEMBER,
        "window_start": WS, "window_end": WE, "run_count": 1, "token_total": 1,
        "cost_total": Decimal("0.01"), "pricing_version": 1, "pricing_status": "known",
        "currency": "USD", "error_count": 0, "duration_seconds_total": 1,
    }
    with pytest.raises(Conflict):
        UsageAuditQuotaRepository(router).upsert_usage(ctx=CTX, payload=payload)
    assert "EXCLUDED.employee_id IS NULL" in router.last_sql
    assert "usage_rollup.member_id = EXCLUDED.member_id" in router.last_sql


def test_usage_upsert_with_delivery_is_one_tenant_transaction():
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=usage_row()),
        FakeCursor(fetchone=delivery_row()),
    )
    payload = {
        "summary_id": "summary-1", "tenant_id": TENANT, "member_id": MEMBER,
        "employee_id": EMPLOYEE, "window_start": WS, "window_end": WE,
        "run_count": 2, "token_total": 33, "cost_total": Decimal("0.125000000001"),
        "pricing_version": 1, "pricing_status": "known", "currency": "USD",
        "error_count": 0, "duration_seconds_total": 3, "prompt_count": 2,
        "settled_count": 1, "input_tokens": 10, "output_tokens": 20,
        "cache_tokens": 3, "duration_ms_total": 1234,
    }
    row = UsageAuditQuotaRepository(router).upsert_usage_with_delivery(
        CTX, payload=payload,
    )
    assert row.member_id == MEMBER
    assert row.input_tokens == 10
    assert any("usage_operator_delivery" in sql for sql, _ in router.executed)
    assert len(router.executed) == 2


def test_delivery_claim_sql_enforces_attempt_and_claim_lease_bounds():
    router = FakeRouter().queue(FakeCursor(fetchall=[delivery_row()]))
    rows = UsageOperatorDeliveryRepository(router).claim_due(CTX, limit=100)
    assert len(rows) == 1
    sql = router.last_sql
    assert "FOR UPDATE SKIP LOCKED" in sql
    assert "attempts < %s" in sql
    assert "interval '1 second'" in sql
    assert MAX_DELIVERY_ATTEMPTS in router.executed[-1][1]


def test_delivery_failed_sql_terminally_clears_next_attempt_after_bound():
    router = FakeRouter().queue(FakeCursor(fetchone=("55555555-5555-5555-5555-555555555555",)))
    ok = UsageOperatorDeliveryRepository(router).mark_failed(
        CTX,
        delivery_id="55555555-5555-5555-5555-555555555555",
        claim_token="claim",
        error="operator unavailable",
        attempts=MAX_DELIVERY_ATTEMPTS,
    )
    assert ok is True
    sql = router.last_sql
    assert "attempts >= %s" in sql
    assert "next_attempt_at = CASE" in sql
    assert router.executed[-1][1][0] == "operator unavailable"


def test_statistics_repository_query_does_not_join_delivery_state():
    router = FakeRouter().queue(FakeCursor(fetchone=(
        2, 4, 3, 4, 2, 1, 10, 20, 3, 33, 1234, 2,
        Decimal("0.125"), 0, 0, 0,
    )))
    result = UsageAuditQuotaRepository(router).aggregate_usage_statistics(
        CTX, employee_id=EMPLOYEE, member_id=MEMBER, window_start=WS, window_end=WE,
    )
    assert result["execution_count"] == 4
    assert result["token_total"] == 33
    assert "usage_operator_delivery" not in router.last_sql
    assert "u.employee_id = %s::uuid" in router.last_sql
    assert "u.member_id = %s::uuid" in router.last_sql


def test_history_repository_retains_unknown_legacy_attribution():
    router = FakeRouter().queue(FakeCursor(fetchall=[(
        "77777777-7777-7777-7777-777777777777", "legacy-summary", None, None,
        None, None, WS, WE, 1, 0, 0, 4, Decimal("0"), None, "unknown", "USD", 1, 1, 0, WS,
    )]))
    rows = UsageAuditQuotaRepository(router).list_usage_history(CTX, limit=10)
    assert rows[0]["member_id"] is None
    assert rows[0]["employee_id"] is None
    assert rows[0]["member_display_name"] == "未知成员"
    assert rows[0]["employee_display_name"] == "未知员工"


def test_delivery_helpers_normalize_uuid_and_payload_shapes():
    value = uuid4()
    assert _to_uuid(None) is None
    assert _to_uuid("") is None
    assert _to_uuid(value) == value
    assert _to_uuid(str(value)) == value
    assert _payload_dict({"summary_id": "s"}) == {"summary_id": "s"}
    assert _payload_dict('{"summary_id":"s"}') == {"summary_id": "s"}
    assert _payload_dict("not-json") == {}
    row = _row_to_delivery(delivery_row())
    assert row.delivery_id == "55555555-5555-5555-5555-555555555555"
    assert row.member_id == MEMBER and row.employee_id == EMPLOYEE


def test_delivery_repository_enqueue_assign_get_list_and_pending_count():
    payload = {
        "summary_id": "summary-1", "employee_id": EMPLOYEE, "member_id": MEMBER,
        "window_start": WS, "window_end": WE, "run_count": 2, "token_total": 33,
        "cost_total": Decimal("0.125"), "pricing_version": 1, "pricing_status": "known",
        "currency": "USD", "error_count": 0, "duration_seconds_total": 3,
    }
    router = FakeRouter().queue(FakeCursor(fetchone=delivery_row()))
    repo = UsageOperatorDeliveryRepository(router)
    assert repo.enqueue(CTX, summary_payload=payload, enterprise_id="66666666-6666-6666-6666-666666666666").summary_id == "summary-1"

    rows = [("55555555-5555-5555-5555-555555555555", TENANT, None, "summary-1", "old", payload, "pending", 0, WS, None, None, None, WS, WS, None, MEMBER, EMPLOYEE)]
    router = FakeRouter().queue_many(FakeCursor(fetchall=rows), FakeCursor(rowcount=1))
    repo = UsageOperatorDeliveryRepository(router)
    assert repo.assign_enterprise_id(CTX, enterprise_id="66666666-6666-6666-6666-666666666666") == 1
    assert len(router.executed) == 2

    router = FakeRouter().queue(FakeCursor(fetchone=delivery_row()))
    assert UsageOperatorDeliveryRepository(router).get(CTX, delivery_id=delivery_row()[0]).summary_id == "summary-1"
    router = FakeRouter().queue(FakeCursor(fetchall=[delivery_row()]))
    assert len(UsageOperatorDeliveryRepository(router).list(CTX, statuses=("pending",), limit=999)) == 1

    router = FakeRouter().queue(FakeCursor(fetchone=(3,)))
    assert UsageOperatorDeliveryRepository(router).pending_count(CTX) == 3


def test_delivery_repository_marks_sent_and_failed_with_claim_fences():
    router = FakeRouter().queue(FakeCursor(fetchone=(delivery_row()[0],)))
    assert UsageOperatorDeliveryRepository(router).mark_sent(
        CTX, delivery_id=delivery_row()[0], claim_token="claim",
    ) is True
    router = FakeRouter().queue(FakeCursor(fetchone=None))
    assert UsageOperatorDeliveryRepository(router).mark_sent(
        CTX, delivery_id=delivery_row()[0], claim_token="stale",
    ) is False
    router = FakeRouter().queue(FakeCursor(fetchone=(delivery_row()[0],)))
    assert UsageOperatorDeliveryRepository(router).mark_failed(
        CTX, delivery_id=delivery_row()[0], claim_token="claim", error="  operator\nsecret  ", attempts=2,
    ) is True
    assert router.executed[-1][1][0] == "operator secret"
