"""billing_repository.py branch coverage (issue #265)."""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from manager_service.billing_repository import BillingRepository, BillingBalanceRow, RechargeRecordRow
from ._fake_router import FakeCursor, FakeRouter, ctx


def _bal_row(balance="100", est=100000, warn="50", reserved=0):
    from datetime import datetime
    return (Decimal(balance), est, Decimal(warn), reserved, datetime.utcnow())


def _rec_row(rid="r-1", amt=Decimal("10"), pm="mock_pay", status="success",
             order="R123", tc=1000):
    from datetime import datetime
    return (rid, amt, pm, status, order, tc, datetime.utcnow())


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
