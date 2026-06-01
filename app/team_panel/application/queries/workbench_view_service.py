"""Workbench view service — aggregates workbench home page data."""

from __future__ import annotations

from datetime import date

from ...transactions.uow import UnitOfWork
from ...views.assemblers import assemble_workbench
from ...views.schemas import WorkbenchView


def get_workbench_view(uow: UnitOfWork, enterprise_id: str) -> WorkbenchView:
    """Build the workbench aggregate view for an enterprise.

    Reads employees, conversations, and today's runs from repos under
    the active UoW transaction.  Token count is a simple sum across
    today's run result summaries (bounded; full aggregation uses billing_view_service).
    """
    employees = uow.employees().list_by_enterprise(enterprise_id)
    conversations = uow.conversations().list_by_enterprise(enterprise_id)
    runs = uow.team_runs().list_by_enterprise(enterprise_id)

    today_str = str(date.today())
    today_runs = [r for r in runs if r.created_at[:10] == today_str]

    today_tokens = 0
    for r in today_runs:
        from ...views.assemblers import _parse_tokens_from_json
        today_tokens += _parse_tokens_from_json(r.result_summary_json)

    return assemble_workbench(
        enterprise_id=enterprise_id,
        employees=employees,
        conversations=conversations,
        today_runs=today_runs,
        today_tokens=today_tokens,
    )
