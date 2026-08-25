"""billing_repository.py usage overview/records coverage (issue #333)."""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from manager_service.billing_repository import (
    BillingRepository,
    _period_to_window,
)
from ._fake_router import FakeCursor, FakeRouter, ctx


def _overview_total_row(tokens=5000, cost=Decimal("12.50")):
    return (tokens, cost, 100, 1)


def _overview_top_row(emp_id="33333333-3333-3333-3333-333333333333", tokens=3000):
    return (emp_id, tokens)


def _trend_row(day_str="2026-06-01", tokens=1000, cost=Decimal("2.50")):
    from datetime import date
    return (date.fromisoformat(day_str), tokens, cost)


def _ranking_row(emp_id="33333333-3333-3333-3333-333333333333", tokens=3000, cost=Decimal("7.50")):
    return (emp_id, tokens, cost)


def _record_row(rid="r-1", emp_id="33333333-3333-3333-3333-333333333333",
                name="Alice", date=None, it=100, ot=200, cost=Decimal("0.50")):
    return (rid, emp_id, date or datetime(2026, 6, 15, tzinfo=timezone.utc), ot, cost)


# ---- _period_to_window ----

def test_period_to_window_all():
    s, e = _period_to_window("all")
    assert s is None and e is None


def test_period_to_window_month_start_is_first_of_current_month():
    s, e = _period_to_window("month")
    now = datetime.now(timezone.utc)
    assert s is not None and e is None
    assert s.day == 1 and s.hour == 0 and s.minute == 0
    assert s.year == now.year and s.month == now.month


def test_period_to_window_last_month_bounds():
    s, e = _period_to_window("last_month")
    assert s is not None and e is not None
    assert s.day == 1
    assert e.day == 1
    assert (e - s).days >= 28


def test_period_to_window_unknown_defaults_to_month():
    s, e = _period_to_window("bogus")
    assert s is not None and e is None
    assert s.day == 1


# ---- get_usage_overview ----

def test_get_usage_overview_aggregates():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_overview_total_row()))
    router.queue(FakeCursor(fetchone=_overview_top_row()))
    router.queue(FakeCursor(fetchall=[_trend_row()]))
    router.queue(FakeCursor(fetchall=[_ranking_row()]))
    repo = BillingRepository(router)
    data = repo.get_usage_overview(ctx(), period="all")
    assert data["period"] == "all"
    assert data["total_tokens"] == 5000
    assert data["total_cost"] == Decimal("12.50")
    assert data["unknown_pricing_tokens"] == 100
    assert data["unknown_pricing_runs"] == 1
    assert data["top_employee_id"] == "33333333-3333-3333-3333-333333333333"
    assert data["top_employee_tokens"] == 3000
    assert data["trend"] == [{"day": "2026-06-01", "tokens": 1000, "cost": Decimal("2.50")}]
    assert data["ranking"] == [
        {"employee_id": "33333333-3333-3333-3333-333333333333", "tokens": 3000, "cost": Decimal("7.50")}
    ]


def test_get_usage_overview_empty_returns_defaults():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=(0, Decimal("0"), 0, 0)))
    router.queue(FakeCursor(fetchone=None))
    router.queue(FakeCursor(fetchall=[]))
    router.queue(FakeCursor(fetchall=[]))
    data = BillingRepository(router).get_usage_overview(ctx(), period="all")
    assert data["total_tokens"] == 0
    assert data["top_employee_id"] is None
    assert data["top_employee_tokens"] == 0
    assert data["trend"] == []
    assert data["ranking"] == []


def test_get_usage_overview_uses_period_window_in_sql():
    """验证 period 窗口条件被拼入 SQL（month 场景）。"""
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=(0, Decimal("0"), 0, 0)))
    router.queue(FakeCursor(fetchone=None))
    router.queue(FakeCursor(fetchall=[]))
    router.queue(FakeCursor(fetchall=[]))
    BillingRepository(router).get_usage_overview(ctx(), period="month")
    # 第一条 total 查询应含窗口条件占位
    assert "window_start >=" in router.executed[0][0]
    assert "IS NULL OR" in router.executed[0][0]


# ---- list_usage_records ----

def test_list_usage_records_returns_rows():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_record_row(), _record_row(rid="r-2", name="Bob")]))
    rows = BillingRepository(router).list_usage_records(ctx(), period="all")
    assert len(rows) == 2
    assert rows[0]["record_id"] == "r-1"
    assert rows[0]["employee_name"] == "33333333-3333-3333-3333-333333333333"
    assert rows[0]["token_total"] == 200
    assert rows[0]["cost"] == Decimal("0.50")
    assert rows[0]["date"].startswith("2026-06-15")


def test_list_usage_records_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    assert BillingRepository(router).list_usage_records(ctx(), period="all") == []


def test_list_usage_records_with_employee_filter():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_record_row()]))
    rows = BillingRepository(router).list_usage_records(
        ctx(), period="month", employee_id="33333333-3333-3333-3333-333333333333",
    )
    assert len(rows) == 1
    sql = router.last_sql
    assert "employee_id = %s::uuid" in sql


def test_list_usage_records_with_period_window():
    """验证 period=last_month 时 occurred_at 过滤条件被拼入。"""
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    BillingRepository(router).list_usage_records(ctx(), period="last_month")
    sql = router.last_sql
    assert "window_start >=" in sql
    assert "window_end <=" in sql


def test_list_usage_records_all_no_period_clause():
    """period=all 时 WHERE 子句不应拼入 occurred_at 过滤（但 SELECT/ORDER BY 仍含该列）。"""
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    BillingRepository(router).list_usage_records(ctx(), period="all")
    sql = router.last_sql
    # WHERE 子句不含 occurred_at 过滤（无 WHERE 或 WHERE 内无 occurred_at）
    where_part = sql.split("WHERE")[1] if "WHERE" in sql else ""
    assert "occurred_at" not in where_part
