"""Run command service -- write-side operations for TeamRun lifecycle."""

import json
import uuid

from team_panel.domain.entities import TeamRun, RuntimeBinding
from team_panel.integration.gateway_client import submit_run


def create_run(uow, conversation_id: str, employee_id: str | None,
               message_text: str, idempotency_key: str) -> dict:
    """Persist a TeamRun with idempotency, call gateway, write RuntimeBinding.

    Returns {run_id, status, stream_url, events_url, runtime_handle}.
    """
    # Idempotency check
    existing = _find_run_by_idempotency(uow, idempotency_key)
    if existing is not None:
        run = uow.team_runs().get_by_id(existing)
        if run is not None:
            binding = uow.runtime_bindings().get_by_owner("team_run", run.id)
            return {
                "run_id": run.id,
                "status": run.status,
                "stream_url": f"/api/team/runs/{run.id}/stream?cursor=0",
                "events_url": f"/api/team/runs/{run.id}/events?cursor=0",
                "runtime_handle": {
                    "session_id": binding.runtime_session_id if binding else None,
                },
            }

    conv = uow.conversations().get_by_id(conversation_id)
    if conv is None:
        raise ValueError(f"Conversation {conversation_id} not found")

    enterprise_id = conv.enterprise_id
    run_id = f"run_{uuid.uuid4().hex[:12]}"

    run = TeamRun(
        id=run_id,
        enterprise_id=enterprise_id,
        conversation_id=conversation_id,
        trigger_type="private_message" if employee_id else "manual_run",
        execution_mode="single_agent",
        status="queued",
        entry_employee_id=employee_id,
        idempotency_key=idempotency_key,
        input_message_json=json.dumps({"message_text": message_text}),
        created_by=employee_id or "system",
    )
    uow.team_runs().create(run)

    # Update conversation mirror fields
    conv.latest_run_id = run_id
    conv.last_message_preview = message_text[:200] if message_text else None
    uow.conversations().update_latest_run(conv.id, run_id, None, conv.last_message_preview or "")

    # Call gateway fake seam
    gw_request = {
        "run_id": run_id,
        "enterprise_id": enterprise_id,
        "employee_id": employee_id or "",
        "conversation_id": conversation_id,
        "message_text": message_text,
        "execution_mode": "single_agent",
    }
    gw_response = submit_run(gw_request)

    # Persist RuntimeBinding
    binding = RuntimeBinding(
        id=f"rb_{uuid.uuid4().hex[:12]}",
        enterprise_id=enterprise_id,
        owner_type="team_run",
        owner_id=run_id,
        profile_name=gw_response.runtime_handle.profile_name,
        runtime_kind="session",
        runtime_session_id=gw_response.runtime_handle.session_id,
        sync_status="pending",
        event_cursor=0,
    )
    uow.runtime_bindings().create(binding)

    return {
        "run_id": run_id,
        "status": run.status,
        "stream_url": gw_response.stream_url,
        "events_url": gw_response.events_url,
        "runtime_handle": {
            "session_id": gw_response.runtime_handle.session_id,
        },
    }


def _find_run_by_idempotency(uow, idempotency_key: str) -> str | None:
    """Return run_id if a run with this idempotency_key exists, else None."""
    existing = uow.team_runs().get_by_idempotency_key(idempotency_key)
    return existing.id if existing else None
