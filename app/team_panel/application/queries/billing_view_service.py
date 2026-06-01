"""Billing view service — aggregates token/cost usage across runs."""

from __future__ import annotations

from datetime import date, datetime, timezone

from ...transactions.uow import UnitOfWork
from ...views.assemblers import assemble_billing_view
from ...views.schemas import BillingView


def get_billing_view(
    uow: UnitOfWork,
    enterprise_id: str,
    *,
    period_start: str | None = None,
    period_end: str | None = None,
) -> BillingView:
    """Build a billing aggregate view for an enterprise in a time window.

    Aggregates tokens and cost from TeamRun.result_summary_json and
    RunEvent payloads (usage_recorded events).  Uses best-effort JSON
    parsing — missing or malformed fields contribute 0.

    Args:
        uow: Active UnitOfWork.
        enterprise_id: Enterprise to query.
        period_start: ISO-8601 date string (inclusive). Defaults to today.
        period_end: ISO-8601 date string (exclusive). Defaults to period_start + 1 day.

    Returns:
        BillingView with total_tokens, total_cost_cents, and per-employee breakdown.
    """
    today = str(date.today())
    period_start = period_start or today
    period_end = period_end or _next_day(period_start)

    runs = uow.team_runs().list_by_enterprise(enterprise_id)

    # Filter by time window (created_at)
    windowed_runs = [
        r for r in runs
        if period_start <= r.created_at[:10] < period_end
    ]

    # Collect events for usage_recorded aggregation
    events_by_run: dict[str, list] = {}
    usage_events = _fetch_usage_events(uow, {r.id for r in windowed_runs})
    for r in windowed_runs:
        evs = [e for e in usage_events if e.run_id == r.id]
        events_by_run[r.id] = evs

    # Employee map for display names
    employees = uow.employees().list_by_enterprise(enterprise_id)
    emp_map = {e.id: e for e in employees}

    return assemble_billing_view(
        enterprise_id=enterprise_id,
        period_start=period_start,
        period_end=period_end,
        runs=windowed_runs,
        events_by_run=events_by_run,
        employee_map=emp_map,
    )


def _next_day(date_str: str) -> str:
    """Return the next calendar day as ISO-8601."""
    from datetime import timedelta
    d = datetime.strptime(date_str, "%Y-%m-%d").date()
    return str(d + timedelta(days=1))


def _fetch_usage_events(uow: UnitOfWork, run_ids: set[str]) -> list:
    """Fetch usage_recorded events for a set of runs."""
    all_events: list = []
    for rid in run_ids:
        evs = uow.run_events().list_by_run(rid, after_cursor=0, limit=500)
        all_events.extend(evs)
    return all_events
