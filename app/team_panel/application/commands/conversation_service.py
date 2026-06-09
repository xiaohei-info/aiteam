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


def add_group_member(uow, conversation_id: str, employee_id: str, *, role: str = "participant") -> dict:
    """Add or reactivate an employee member for a group conversation."""
    conv = uow.conversations().get_by_id(conversation_id)
    if conv is None:
        raise ValueError(f"Conversation {conversation_id} not found")
    if conv.type != "group":
        raise ValueError(f"Conversation {conversation_id} is not a group conversation")
    employee = uow.employees().get_by_id(employee_id)
    if employee is None:
        raise ValueError(f"Employee {employee_id} not found")

    uow.cur.execute(
        """
        SELECT member_id, status
        FROM conversation_member
        WHERE conversation_id = %s AND member_type = 'employee' AND member_ref_id = %s
        """,
        (conversation_id, employee_id),
    )
    row = uow.cur.fetchone()
    if row is not None:
        member_id, status = row[0], row[1]
        if status != "active":
            uow.cur.execute(
                """
                UPDATE conversation_member
                SET status = 'active', role = %s, removed_at = NULL, updated_at = now()
                WHERE member_id = %s
                """,
                (role, member_id),
            )
        return {"member_id": member_id, "employee_id": employee_id, "status": "active"}

    member_id = f"mem_{uuid.uuid4().hex[:12]}"
    member = ConversationMember(
        member_id=member_id,
        conversation_id=conversation_id,
        member_type="employee",
        member_ref_id=employee_id,
        role=role,
        status="active",
    )
    _create_member(uow, member)
    return {"member_id": member_id, "employee_id": employee_id, "status": "active"}


def remove_group_member(uow, conversation_id: str, member_id: str) -> dict:
    """Soft-remove a member from a group conversation."""
    conv = uow.conversations().get_by_id(conversation_id)
    if conv is None:
        raise ValueError(f"Conversation {conversation_id} not found")
    if conv.type != "group":
        raise ValueError(f"Conversation {conversation_id} is not a group conversation")

    uow.cur.execute(
        """
        SELECT member_ref_id, status
        FROM conversation_member
        WHERE conversation_id = %s AND member_id = %s
        """,
        (conversation_id, member_id),
    )
    row = uow.cur.fetchone()
    if row is None:
        raise ValueError(f"Conversation member {member_id} not found")
    if row[1] != "removed":
        uow.cur.execute(
            """
            UPDATE conversation_member
            SET status = 'removed', removed_at = now(), updated_at = now()
            WHERE member_id = %s
            """,
            (member_id,),
        )
    return {"member_id": member_id, "employee_id": row[0], "status": "removed"}


def archive_group_conversation(uow, conversation_id: str) -> dict:
    """Archive a group conversation to represent dissolve semantics."""
    conv = uow.conversations().get_by_id(conversation_id)
    if conv is None:
        raise ValueError(f"Conversation {conversation_id} not found")
    if conv.type != "group":
        raise ValueError(f"Conversation {conversation_id} is not a group conversation")
    conv.archive()
    uow.conversations().update_status(conv)
    return {"conversation_id": conv.id, "status": conv.status}


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
            route_payload = {
                "route_mode": decision.route_mode,
                "target_employee_ids": list(decision.target_employee_ids),
                "planner_employee_id": decision.planner_employee_id,
            }
            summary = json.loads(run.result_summary_json or "{}") if run.result_summary_json else {}
            if summary.get("entry_employee_id"):
                route_payload["entry_employee_id"] = summary.get("entry_employee_id")
            if summary.get("candidate_employee_ids"):
                route_payload["candidate_employee_ids"] = list(summary.get("candidate_employee_ids") or [])
            return {
                "message_id": existing_msg_id or "",
                "run_id": run.id,
                "route_decision": route_payload,
                "stream_url": f"/api/team/runs/{run.id}/stream?cursor=0",
                "events_url": f"/api/team/runs/{run.id}/events?cursor=0",
                "runtime_handle": {
                    "kind": binding.runtime_kind if binding else None,
                    "session_id": binding.runtime_session_id if binding else None,
                    "task_id": binding.runtime_task_id if binding else None,
                },
            }

    # ── Resolve available members from conversation members ─────────
    available_members = _get_active_members(uow, conversation_id)
    available_employee_ids = [member["employee_id"] for member in available_members]
    if sender_id not in available_employee_ids:
        raise ValueError(f"sender_id {sender_id} is not an active conversation member")

    # ── Compute route decision ─────────────────────────────────────
    decision = decide_route(message_text, available_members, route_hint)
    entry_employee_id = _pick_entry_employee_id(decision, sender_id)
    candidate_employee_ids = _pick_candidate_employee_ids(decision, available_employee_ids)

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
        entry_employee_id=entry_employee_id,
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
            "entry_employee_id": entry_employee_id,
            "candidate_employee_ids": candidate_employee_ids,
        }),
        created_by=sender_id,
    )
    uow.team_runs().create(run)

    # ── Call gateway ───────────────────────────────────────────────
    gw_request = {
        "run_id": run_id,
        "enterprise_id": enterprise_id,
        "employee_id": entry_employee_id,
        "planner_employee_id": decision.planner_employee_id or entry_employee_id,
        "target_employee_ids": candidate_employee_ids,
        "conversation_id": conversation_id,
        "message_id": message_id,
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
            "entry_employee_id": entry_employee_id,
            "planner_employee_id": decision.planner_employee_id or "",
            "target_employee_ids": list(decision.target_employee_ids),
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
            "entry_employee_id": entry_employee_id,
            "candidate_employee_ids": candidate_employee_ids,
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


def _get_active_members(uow, conversation_id: str) -> list[dict[str, str]]:
    """Return active employee members with aliases for a group conversation."""
    uow.cur.execute(
        "SELECT cm.member_ref_id, COALESCE(e.display_name, ''), COALESCE(e.role_name, ''), "
        "COALESCE(e.profile_name, '') "
        "FROM conversation_member cm "
        "LEFT JOIN employee e ON e.id = cm.member_ref_id "
        "WHERE cm.conversation_id = %s AND cm.member_type = 'employee' "
        "AND cm.status = 'active' "
        "ORDER BY cm.member_ref_id",
        (conversation_id,),
    )
    rows = uow.cur.fetchall()
    return [
        {
            "employee_id": row[0],
            "display_name": row[1],
            "role_name": row[2],
            "profile_name": row[3],
        }
        for row in rows if row[0]
    ]


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


def _pick_entry_employee_id(decision, sender_id: str) -> str:
    if decision.route_mode == "single_agent":
        if decision.target_employee_ids:
            return decision.target_employee_ids[0]
        return sender_id
    if decision.planner_employee_id:
        return decision.planner_employee_id
    if decision.target_employee_ids:
        return decision.target_employee_ids[0]
    return sender_id


def _pick_candidate_employee_ids(decision, available_employee_ids: list[str]) -> list[str]:
    if decision.target_employee_ids:
        ordered_targets = list(decision.target_employee_ids)
        if decision.route_mode == "orchestration" and decision.planner_employee_id:
            ordered = [employee_id for employee_id in available_employee_ids if employee_id == decision.planner_employee_id]
            ordered.extend(employee_id for employee_id in ordered_targets if employee_id != decision.planner_employee_id)
            for employee_id in available_employee_ids:
                if employee_id not in ordered and employee_id in ordered_targets:
                    ordered.append(employee_id)
            return ordered
        return ordered_targets
    ordered_available = list(available_employee_ids)
    if decision.route_mode == "single_agent":
        return ordered_available
    if decision.planner_employee_id:
        if decision.planner_employee_id in ordered_available:
            return [decision.planner_employee_id, *[employee_id for employee_id in ordered_available if employee_id != decision.planner_employee_id]]
    return ordered_available


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
