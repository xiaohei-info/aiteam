"""View assemblers — build view schemas from domain entities.

Each assembler is a pure function: entities in, view objects out.
No DB access or side effects.
"""

from __future__ import annotations

import json
from typing import Optional

from ..domain.entities import Conversation, Employee, RunEvent, TeamRun
from ..domain.enums import EmployeeStatus
from .schemas import (
    BillingEmployeeItem,
    BillingView,
    ConversationView,
    WorkbenchConversationItem,
    WorkbenchEmployeeItem,
    WorkbenchView,
    compute_display_state,
)


# ── Workbench ──────────────────────────────────────────────────────────────


def assemble_workbench(
    enterprise_id: str,
    employees: list[Employee],
    conversations: list[Conversation],
    today_runs: list[TeamRun],
    today_tokens: int,
    *,
    team_items: list[WorkbenchEmployeeItem],
    conversation_items: list[WorkbenchConversationItem],
    group_items: list[WorkbenchConversationItem],
    navigation: dict,
    task_status_digest: dict,
    office_digest: dict,
    empty_state: dict | None,
    permissions: dict,
) -> WorkbenchView:
    active_employees = sum(1 for e in employees if e.status == EmployeeStatus.ACTIVE)
    active_convs = sum(1 for c in conversations if c.status == "active")
    recent = conversation_items[:10]
    return WorkbenchView(
        enterprise_id=enterprise_id,
        active_employees=active_employees,
        active_conversations=active_convs,
        today_runs=len(today_runs),
        today_tokens=today_tokens,
        recent_conversations=recent,
        employees=team_items,
        conversations=conversation_items,
        groups=group_items,
        my_team={
            "items": team_items,
            "total": len(team_items),
            "active_count": active_employees,
        },
        navigation=navigation,
        task_status_digest=task_status_digest,
        office_digest=office_digest,
        empty_state=empty_state,
        permissions=permissions,
    )


# ── Conversation ───────────────────────────────────────────────────────────


def assemble_conversation_view(
    conversation: Conversation,
    latest_run: TeamRun | None,
    latest_event: RunEvent | None,
    member_count: int,
) -> ConversationView:
    run_status = latest_run.status if latest_run else None
    has_delta = (
        latest_event is not None and latest_event.event_type == "message_delta"
    )
    display_state = compute_display_state(
        conversation.status, run_status, has_recent_delta=has_delta
    )
    return ConversationView(
        id=conversation.id,
        conv_type=conversation.type,
        status=conversation.status,
        display_state=display_state,
        title=conversation.title,
        last_preview=conversation.last_message_preview or "",
        member_count=member_count,
        updated_at=conversation.updated_at,
    )



def assemble_conversation_views(
    conversations: list[Conversation],
    *,
    latest_runs: dict[str, TeamRun | None],
    latest_events: dict[str, RunEvent | None],
    member_counts: dict[str, int],
) -> list[ConversationView]:
    result: list[ConversationView] = []
    for c in conversations:
        result.append(
            assemble_conversation_view(
                c,
                latest_run=latest_runs.get(c.id),
                latest_event=latest_events.get(c.id),
                member_count=member_counts.get(c.id, 0),
            )
        )
    return result


# ── Billing ────────────────────────────────────────────────────────────────


def _jsonb_to_dict(payload) -> dict | None:
    """Normalize JSONB input that may be a string, dict, or Python repr (from psycopg2)."""
    if payload is None:
        return None
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, str):
        if not payload.strip():
            return None
        try:
            return json.loads(payload)
        except (json.JSONDecodeError, TypeError):
            pass
        # Fallback: psycopg2 JSONB -> str() gives Python repr (single quotes)
        try:
            import ast
            val = ast.literal_eval(payload)
            if isinstance(val, dict):
                return val
        except (ValueError, SyntaxError):
            pass
    return None



def _parse_tokens_from_json(payload_json: str | dict | None) -> int:
    """Best-effort extraction of token count from result_summary_json or payload_json."""
    data = _jsonb_to_dict(payload_json)
    if not data:
        return 0
    tokens = data.get("tokens") or data.get("total_tokens")
    if tokens is not None and isinstance(tokens, (int, float)):
        return int(tokens)
    usage = data.get("usage")
    if isinstance(usage, dict):
        tokens = usage.get("total_tokens") or usage.get("tokens")
        if tokens is not None and isinstance(tokens, (int, float)):
            return int(tokens)
    return 0



def _parse_cost_cents_from_json(payload_json: str | dict | None) -> int:
    """Best-effort extraction of cost (in cents) from result_summary_json."""
    data = _jsonb_to_dict(payload_json)
    if not data:
        return 0
    cost = data.get("cost_cents") or data.get("cost")
    if cost is not None and isinstance(cost, (int, float)):
        return int(cost)
    usage = data.get("usage")
    if isinstance(usage, dict):
        cost = usage.get("cost_cents") or usage.get("cost")
        if cost is not None and isinstance(cost, (int, float)):
            return int(cost)
    return 0



def _aggregate_run_tokens(run: TeamRun, events: list[RunEvent]) -> int:
    """Aggregate tokens for a run from result_summary_json and event payloads."""
    tokens = _parse_tokens_from_json(run.result_summary_json)
    for ev in events:
        if ev.event_type == "usage_recorded":
            tokens += _parse_tokens_from_json(ev.payload_json)
    return tokens



def _aggregate_run_cost_cents(run: TeamRun, events: list[RunEvent]) -> int:
    cost = _parse_cost_cents_from_json(run.result_summary_json)
    for ev in events:
        if ev.event_type == "usage_recorded":
            cost += _parse_cost_cents_from_json(ev.payload_json)
    return cost



def assemble_billing_view(
    enterprise_id: str,
    period_start: str,
    period_end: str,
    runs: list[TeamRun],
    *,
    events_by_run: dict[str, list[RunEvent]] | None = None,
    employee_map: dict[str, Employee] | None = None,
) -> BillingView:
    events_by_run = events_by_run or {}
    employee_map = employee_map or {}
    total_tokens = 0
    total_cost = 0
    by_emp: dict[str, BillingEmployeeItem] = {}

    for run in runs:
        run_events = events_by_run.get(run.id, [])
        t = _aggregate_run_tokens(run, run_events)
        c = _aggregate_run_cost_cents(run, run_events)
        total_tokens += t
        total_cost += c

        eid = run.entry_employee_id or "unknown"
        if eid not in by_emp:
            emp = employee_map.get(eid)
            by_emp[eid] = BillingEmployeeItem(
                employee_id=eid,
                display_name=emp.display_name if emp else "",
            )
        by_emp[eid].tokens += t
        by_emp[eid].cost_cents += c

    return BillingView(
        enterprise_id=enterprise_id,
        period_start=period_start,
        period_end=period_end,
        total_tokens=total_tokens,
        total_cost_cents=total_cost,
        by_employee=list(by_emp.values()),
    )


# ── Helpers ────────────────────────────────────────────────────────────────


def _conversation_display_state(c: Conversation) -> str:
    if c.status != "active":
        return "idle"
    # Without run/event context, best we can infer from conv alone
    return "idle"
