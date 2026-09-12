"""billing_repository.py branch coverage (issue #265)."""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from unittest.mock import MagicMock

import pytest

from manager_service.billing_repository import BillingBalanceRow, BillingRepository, RechargeRecordRow
from manager_service.billing_service import BillingService, _public_recharge
from ._fake_router import FakeCursor, FakeRouter, ctx


def _bal_row(balance="100", est=100000, warn="50", reserved=0):
    from datetime import datetime
    return (Decimal(balance), est, Decimal(warn), reserved, datetime.utcnow())


def _rec_row(rid="r-1", amt=Decimal("10"), pm="mock_pay", status="success",
             order="R123", tc=1000):
    from datetime import datetime
    return (rid, amt, pm, status, order, tc, datetime.utcnow())


def test_public_recharge_serializer_hides_legacy_method():
    row = RechargeRecordRow("legacy", Decimal("10"), "mock_pay", "success", "R0", 1000, datetime.utcnow())
    assert _public_recharge(row)["payment_method"] == "bank_transfer"
    assert _public_recharge(row)["status"] == "failed"
    assert _public_recharge(row)["token_credited"] == 0


def test_billing_service_rejects_mock_and_serializes_history():
    row = RechargeRecordRow("r1", Decimal("10"), "wechat_pay", "pending", "R1", 1000, datetime.utcnow())
    repo = MagicMock()
    repo.list_recharges.return_value = [row]
    repo.create_recharge.return_value = row
    repo.get_balance.return_value = BillingBalanceRow(
        balance=Decimal("100"), estimated_tokens=100000, warning_threshold=Decimal("50"),
        reserved_tokens=0, updated_at=datetime.utcnow(),
    )
    repo.get_usage_overview.return_value = {"period": "all", "total_tokens": 1, "total_cost": None}
    repo.list_usage_records.return_value = [{"record_id": "r1", "employee_name": "员工", "token_total": 1}]
    service = BillingService(repo)
    assert service.list_recharges(ctx())[0]["payment_method"] == "wechat_pay"
    assert service.get_balance(ctx())["estimated_tokens"] == 100000
    assert service.get_usage_overview(ctx(), period="all")["total_tokens"] == 1
    assert service.list_usage_records(ctx(), period="all")[0]["record_id"] == "r1"
    with pytest.raises(ValueError, match="unsupported payment method"):
        service.create_recharge(ctx(), Decimal("1"), "mock_pay")
    assert service.create_recharge(ctx(), Decimal("1"), "wechat_pay")["status"] == "pending"


def test_get_balance_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_bal_row()))
    row = BillingRepository(router).get_balance(ctx())
    assert row.balance == Decimal("100")

def test_get_balance_none_returns_default():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    row = BillingRepository(router).get_balance(ctx())
    assert row.balance == Decimal("0")

def test_upsert_balance():
    router = FakeRouter()
    router.queue(FakeCursor(rowcount=1))  # INSERT ... ON CONFLICT
    router.queue(FakeCursor(fetchone=_bal_row(balance="60")))  # subsequent get_balance
    row = BillingRepository(router).upsert_balance(ctx(), balance=Decimal("50"), estimated_tokens=5000)
    assert row.balance == Decimal("60")

def test_create_recharge():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_rec_row()))
    row = BillingRepository(router).create_recharge(
        ctx(), amount=Decimal("10"), payment_method="mock_pay",
        status="success", order_no="R1", token_credited=1000,
    )
    assert row.status == "success"
    assert row.token_credited == 1000

def test_list_recharges_returns_rows():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_rec_row("r1"), _rec_row("r2")]))
    rows = BillingRepository(router).list_recharges(ctx())
    assert len(rows) == 2

def test_list_recharges_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    assert BillingRepository(router).list_recharges(ctx()) == []


def test_list_usage_records_filters_unattributed_rollups():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[("r1", "employee-1", "Helper", datetime(2026, 1, 1), 10, Decimal("1.25"))]))
    records = BillingRepository(router).list_usage_records(ctx(), period="all")
    assert records[0]["employee_id"] == "employee-1"
    query, _ = router.executed[0]
    assert "u.employee_id IS NOT NULL" in query
    assert "LEFT JOIN employee AS e" in query


def test_billing_usage_queries_apply_employee_and_member_filters_and_rich_rows():
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=(10, Decimal("1.5"), 2, 1, Decimal("1.5"), 0, 2, 3, 4)),
        FakeCursor(fetchone=("employee-1", 10)),
        FakeCursor(fetchall=[(datetime(2026, 1, 1).date(), 10, Decimal("1.5"), 0)]),
        FakeCursor(fetchall=[("employee-1", 10, Decimal("1.5"), 0)]),
    )
    repo = BillingRepository(router)
    overview = repo.get_usage_overview(
        ctx(), period="all", employee_id="11111111-1111-1111-1111-111111111111",
        member_id="22222222-2222-2222-2222-222222222222",
    )
    assert overview["pricing_status"] == "known"
    assert overview["trend"][0]["cost"] == Decimal("1.5")
    assert overview["ranking"][0]["cost"] == Decimal("1.5")
    assert all("employee_id = %s::uuid" in sql and "member_id = %s::uuid" in sql for sql, _ in router.executed)

    rich = (
        "r2", "employee-1", "member-1", "员工", "成员", datetime(2026, 1, 1), datetime(2026, 1, 2),
        10, Decimal("1.25"), 2, "known", 3,
    )
    router = FakeRouter().queue(FakeCursor(fetchall=[rich]))
    records = BillingRepository(router).list_usage_records(
        ctx(), period="all", employee_id="11111111-1111-1111-1111-111111111111",
        member_id="22222222-2222-2222-2222-222222222222",
    )
    assert records[0]["member_id"] == "member-1"
    assert records[0]["execution_count"] == 3
    assert "u.member_id = %s::uuid" in router.last_sql
