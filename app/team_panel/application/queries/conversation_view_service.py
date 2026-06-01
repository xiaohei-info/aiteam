"""Conversation view service — aggregates conversation detail views."""

from __future__ import annotations

from ...domain.entities import RunEvent, TeamRun
from ...transactions.uow import UnitOfWork
from ...views.assemblers import assemble_conversation_view, assemble_conversation_views
from ...views.cursor_queries import get_latest_event, get_latest_events_for_runs
from ...views.schemas import ConversationView


def get_conversation_view(
    uow: UnitOfWork, conversation_id: str
) -> ConversationView | None:
    """Build a single conversation aggregate view with computed display_state."""
    conv = uow.conversations().get_by_id(conversation_id)
    if conv is None:
        return None

    latest_run: TeamRun | None = None
    latest_event: RunEvent | None = None
    if conv.latest_run_id:
        latest_run = uow.team_runs().get_by_id(conv.latest_run_id)
        if latest_run:
            latest_event = get_latest_event(uow.run_events(), conv.latest_run_id)

    # Member count — V1: not implemented, default to 0
    member_count = 0

    return assemble_conversation_view(conv, latest_run, latest_event, member_count)


def list_conversation_views(
    uow: UnitOfWork, enterprise_id: str
) -> list[ConversationView]:
    """Build conversation views for all conversations in an enterprise."""
    conversations = uow.conversations().list_by_enterprise(enterprise_id)

    # Bulk-fetch latest runs keyed by conversation id (assembler contract)
    latest_runs: dict[str, TeamRun | None] = {}
    run_ids: set[str] = set()
    for conversation in conversations:
        latest_run = (
            uow.team_runs().get_by_id(conversation.latest_run_id)
            if conversation.latest_run_id
            else None
        )
        latest_runs[conversation.id] = latest_run
        if latest_run is not None:
            run_ids.add(latest_run.id)

    # Bulk-fetch latest events for each run, then remap to conversation id
    latest_events_by_run = get_latest_events_for_runs(uow.run_events(), run_ids)
    conv_events: dict[str, RunEvent | None] = {}
    for conversation in conversations:
        latest_run = latest_runs.get(conversation.id)
        conv_events[conversation.id] = (
            latest_events_by_run.get(latest_run.id) if latest_run is not None else None
        )

    member_counts = {conversation.id: 0 for conversation in conversations}  # V1: skip member counting for list view

    return assemble_conversation_views(
        conversations,
        latest_runs=latest_runs,
        latest_events=conv_events,
        member_counts=member_counts,
    )
