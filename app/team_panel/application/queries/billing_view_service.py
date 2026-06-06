"""Billing view service — aggregates token/cost usage across runs."""

from __future__ import annotations

from datetime import date, datetime

from ...domain.entities import UsageLedger
from ...transactions.uow import UnitOfWork
from ...views.assemblers import (
    _aggregate_run_cost_cents,
    _aggregate_run_tokens,
    _jsonb_to_dict,
)
from ...views.schemas import BillingEmployeeItem, BillingView


def get_billing_view(
    uow: UnitOfWork,
    enterprise_id: str,
    *,
    period_start: str | None = None,
    period_end: str | None = None,
) -> BillingView:
    """Build a billing aggregate view for an enterprise in a time window.

    The service normalizes run summary + usage_recorded events into usage_ledger
    rows first, then serves the B04 view from that ledger so downstream detail,
    ranking, and future exports share one persisted grain.
    """
    today = str(date.today())
    period_start = period_start or today
    period_end = period_end or _next_day(period_start)

    runs = uow.team_runs().list_by_enterprise(enterprise_id)
    windowed_runs = [r for r in runs if period_start <= r.created_at[:10] < period_end]

    events_by_run: dict[str, list] = {}
    usage_events = _fetch_usage_events(uow, {r.id for r in windowed_runs})
    for r in windowed_runs:
        events_by_run[r.id] = [e for e in usage_events if e.run_id == r.id]

    _materialize_usage_ledger(uow, enterprise_id, windowed_runs, events_by_run)

    ledgers = uow.usage_ledgers().list_by_enterprise(
        enterprise_id,
        period_start=f"{period_start}T00:00:00Z",
        period_end=f"{period_end}T00:00:00Z",
    )
    employees = uow.employees().list_by_enterprise(enterprise_id)
    emp_map = {e.id: e for e in employees}

    by_employee: dict[str, BillingEmployeeItem] = {}
    total_tokens = 0
    total_cost_cents = 0
    for ledger in ledgers:
        total_tokens += ledger.total_tokens
        total_cost_cents += ledger.cost_cents
        employee = emp_map.get(ledger.employee_id)
        item = by_employee.setdefault(
            ledger.employee_id,
            BillingEmployeeItem(
                employee_id=ledger.employee_id,
                display_name=employee.display_name if employee is not None else "",
            ),
        )
        item.tokens += ledger.total_tokens
        item.cost_cents += ledger.cost_cents

    return BillingView(
        enterprise_id=enterprise_id,
        period_start=period_start,
        period_end=period_end,
        total_tokens=total_tokens,
        total_cost_cents=total_cost_cents,
        by_employee=list(by_employee.values()),
    )


def _materialize_usage_ledger(uow: UnitOfWork, enterprise_id: str, runs: list, events_by_run: dict[str, list]) -> None:
    for run in runs:
        run_events = events_by_run.get(run.id, [])
        usage_summary = _jsonb_to_dict(run.result_summary_json) or {}
        usage = usage_summary.get("usage") if isinstance(usage_summary.get("usage"), dict) else usage_summary
        input_tokens = int(usage.get("input_tokens") or 0) if isinstance(usage, dict) else 0
        output_tokens = int(usage.get("output_tokens") or 0) if isinstance(usage, dict) else 0
        total_tokens = _aggregate_run_tokens(run, run_events)
        cost_cents = _aggregate_run_cost_cents(run, run_events)
        occurred_at = run.finished_at or run.updated_at or run.created_at
        uow.usage_ledgers().upsert(
            UsageLedger(
                id=f"ulg_{run.id}_run_summary",
                enterprise_id=enterprise_id,
                employee_id=run.entry_employee_id or "unknown",
                conversation_id=run.conversation_id,
                run_id=run.id,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                total_tokens=total_tokens,
                cost_cents=cost_cents,
                source_type="run_summary",
                occurred_at=occurred_at,
                created_by="billing_view_service",
                updated_by="billing_view_service",
            )
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
        all_events.extend(uow.run_events().list_by_run(rid, after_cursor=0, limit=500))
    return all_events
