"""Conversation command service -- write-side operations for conversations."""

import json
import uuid

from team_panel.domain.entities import (
    AuditEvent,
    Conversation,
    ConversationMember,
    ConversationMessage,
    RuntimeBinding,
    TeamRun,
)
from team_panel.application.policies.route_decision_service import decide_route
from team_panel.integration.gateway_client import submit_group_conversation


def create_private_conversation(uow, enterprise_id: str, employee_id: str,
                                created_by: str) -> str:
    """Create a private conversation, activate it, and return its id."""
    conv_id = f"conv_{uuid.uuid4().hex[:12]}"
    conv = Conversation(
        id=conv_id,
        enterprise_id=enterprise_id,
        type="private",
        status="draft",
        entry_employee_id=employee_id,
        created_by=created_by,
    )
    conv.activate()
    uow.conversations().create(conv)
    return conv_id


def create_group_conversation(uow, enterprise_id: str, title: str,
                              member_employee_ids: list[str],
                              created_by: str) -> str:
    """Create a group conversation with membership entries, activate, return id."""
    conv_id = f"conv_{uuid.uuid4().hex[:12]}"
    conv = Conversation(
        id=conv_id,
        enterprise_id=enterprise_id,
        type="group",
        status="draft",
        title=title,
        created_by=created_by,
    )
    conv.activate()
    uow.conversations().create(conv)

    for employee_id in member_employee_ids:
        member = ConversationMember(
            member_id=f"mem_{uuid.uuid4().hex[:12]}",
            conversation_id=conv_id,
            member_type="employee",
            member_ref_id=employee_id,
            role="participant",
            status="active",
        )
        _create_member(uow, member)

    return conv_id


def submit_group_message(uow, conversation_id: str, message_text: str,
                         route_hint: str, idempotency_key: str,
                         sender_id: str) -> dict:
    """Submit a message to a group conversation.

    Computes route_decision from @mentions / route_hint, persists a TeamRun,
    RuntimeBinding, and audit event, then returns the northbound response.
    """
    conv = uow.conversations().get_by_id(conversation_id)
    if conv is None:
        raise ValueError(f"Conversation {conversation_id} not found")
    if conv.type != "group":
        raise ValueError(f"Conversation {conversation_id} is not a group conversation")
    if conv.status != "active":
        raise ValueError(f"Cannot submit to {conv.status} conversation")
    if not sender_id:
        raise ValueError("sender_id is required")

    # ── Idempotency check ──────────────────────────────────────────
    existing = _find_run_by_idempotency(uow, idempotency_key)
    if existing is not None:
        run = uow.team_runs().get_by_id(existing)
        if run is not None:
            binding = uow.runtime_bindings().get_by_owner("team_run", run.id)
            decision = _load_route_decision(run)
            existing_msg_id = _find_message_id_for_run(uow, run.id)
            return {
                "message_id": existing_msg_id or "",
                "run_id": run.id,
                "route_decision": {
                    "route_mode": decision.route_mode,
                    "target_employee_ids": list(decision.target_employee_ids),
                    "planner_employee_id": decision.planner_employee_id,
                },
                "stream_url": f"/api/team/runs/{run.id}/stream?cursor=0",
                "events_url": f"/api/team/runs/{run.id}/events?cursor=0",
                "runtime_handle": {
                    "kind": binding.runtime_kind if binding else None,
                    "session_id": binding.runtime_session_id if binding else None,
                    "task_id": binding.runtime_task_id if binding else None,
                },
            }

    # ── Resolve available employees from conversation members ──────
    available = _get_active_member_employee_ids(uow, conversation_id)

    # ── Compute route decision ─────────────────────────────────────
    decision = decide_route(message_text, available, route_hint)

    # ── Map route_mode → execution_mode ────────────────────────────
    if decision.route_mode == "orchestration":
        execution_mode = "kanban_orchestration"
    else:
        execution_mode = "single_agent"

    enterprise_id = conv.enterprise_id
    message_id = f"msg_{uuid.uuid4().hex[:12]}"
    run_id = f"run_{uuid.uuid4().hex[:12]}"

    # ── Persist ConversationMessage artifact ────────────────────────
    msg = ConversationMessage(
        id=message_id,
        conversation_id=conversation_id,
        run_id=run_id,
        sender_id=sender_id,
        sender_type="user",
        message_text=message_text,
        message_json=json.dumps({
            "route_hint": route_hint,
            "idempotency_key": idempotency_key,
        }),
    )
    uow.conversation_messages().create(msg)

    # ── Persist TeamRun ────────────────────────────────────────────
    run = TeamRun(
        id=run_id,
        enterprise_id=enterprise_id,
        conversation_id=conversation_id,
        trigger_type="group_message",
        execution_mode=execution_mode,
        status="queued",
        planner_employee_id=decision.planner_employee_id or None,
        idempotency_key=idempotency_key,
        input_message_json=json.dumps({
            "message_text": message_text,
            "route_hint": route_hint,
        }),
        result_summary_json=json.dumps({
            "route_mode": decision.route_mode,
            "target_employee_ids": list(decision.target_employee_ids),
            "planner_employee_id": decision.planner_employee_id or "",
        }),
        created_by=sender_id,
    )
    uow.team_runs().create(run)

    # ── Call gateway ───────────────────────────────────────────────
    entry_employee = sender_id if execution_mode == "single_agent" else ""
    gw_request = {
        "run_id": run_id,
        "enterprise_id": enterprise_id,
        "employee_id": entry_employee,
        "conversation_id": conversation_id,
        "message_text": message_text,
        "execution_mode": execution_mode,
        "route_mode": decision.route_mode,
        "idempotency_key": idempotency_key,
    }
    gw_response = submit_group_conversation(gw_request)

    # ── Persist RuntimeBinding ─────────────────────────────────────
    runtime_kind = "session" if gw_response.runtime_handle.kind == "session" else "kanban_task"
    binding = RuntimeBinding(
        id=f"rb_{uuid.uuid4().hex[:12]}",
        enterprise_id=enterprise_id,
        owner_type="team_run",
        owner_id=run_id,
        profile_name=gw_response.runtime_handle.profile_name,
        runtime_kind=runtime_kind,
        runtime_session_id=gw_response.runtime_handle.session_id,
        runtime_task_id=gw_response.runtime_handle.task_id,
        sync_status="pending",
        event_cursor=0,
    )
    uow.runtime_bindings().create(binding)

    # ── Audit event ────────────────────────────────────────────────
    audit = AuditEvent(
        id=f"audit_{uuid.uuid4().hex[:12]}",
        enterprise_id=enterprise_id,
        actor_type="user",
        actor_id=sender_id,
        event_type="group_message.accepted",
        target_type="team_run",
        target_id=run_id,
        request_id=idempotency_key,
        payload_json=json.dumps({
            "conversation_id": conversation_id,
            "route_mode": decision.route_mode,
            "execution_mode": execution_mode,
        }),
        created_by=sender_id,
    )
    uow.audit_events().create(audit)

    # ── Update conversation mirror ─────────────────────────────────
    conv.latest_run_id = run_id
    conv.latest_message_id = message_id
    conv.last_message_preview = message_text[:200] if message_text else None
    uow.conversations().update_latest_run(
        conv.id, run_id, message_id, conv.last_message_preview or "",
    )

    return {
        "message_id": message_id,
        "run_id": run_id,
        "route_decision": {
            "route_mode": decision.route_mode,
            "target_employee_ids": list(decision.target_employee_ids),
            "planner_employee_id": decision.planner_employee_id,
        },
        "stream_url": gw_response.stream_url,
        "events_url": gw_response.events_url,
        "runtime_handle": {
            "kind": runtime_kind,
            "session_id": gw_response.runtime_handle.session_id,
            "task_id": gw_response.runtime_handle.task_id,
        },
    }


def _find_run_by_idempotency(uow, idempotency_key: str) -> str | None:
    """Return run_id if a run with this idempotency_key exists, else None."""
    existing = uow.team_runs().get_by_idempotency_key(idempotency_key)
    return existing.id if existing else None


def _get_active_member_employee_ids(uow, conversation_id: str) -> list[str]:
    """Return active employee member IDs for a group conversation."""
    uow.cur.execute(
        "SELECT member_ref_id FROM conversation_member "
        "WHERE conversation_id = %s AND member_type = 'employee' "
        "AND status = 'active' "
        "ORDER BY member_ref_id",
        (conversation_id,),
    )
    rows = uow.cur.fetchall()
    return [row[0] for row in rows]


def _load_route_decision(run):
    """Reconstruct RouteDecision from a persisted TeamRun's result_summary_json."""
    from team_panel.domain.value_objects import RouteDecision
    try:
        data = json.loads(run.result_summary_json or "{}")
    except (json.JSONDecodeError, TypeError):
        data = {}
    return RouteDecision(
        route_mode=data.get("route_mode", "single_agent"),
        target_employee_ids=tuple(data.get("target_employee_ids", [])),
        planner_employee_id=data.get("planner_employee_id", ""),
    )


def _create_member(uow, member: ConversationMember) -> None:
    """Persist a ConversationMember via raw cursor (no dedicated repo yet)."""
    uow.cur.execute(
        "INSERT INTO conversation_member (member_id, conversation_id, "
        "member_type, member_ref_id, role, status) "
        "VALUES (%s, %s, %s, %s, %s, %s)",
        (member.member_id, member.conversation_id, member.member_type,
         member.member_ref_id, member.role, member.status),
    )


def _find_message_id_for_run(uow, run_id: str) -> str | None:
    """Return the message_id linked to a run, or None."""
    uow.cur.execute(
        "SELECT id FROM conversation_message WHERE run_id = %s LIMIT 1",
        (run_id,),
    )
    row = uow.cur.fetchone()
    return row[0] if row else None
