"""Orchestration command service -- write-side operations for kanban orchestration runs."""

import json
import uuid

from team_panel.domain.entities import TeamRun, TeamTask, RuntimeBinding
from team_panel.integration.gateway_client import submit_orchestration


def create_orchestration_run(uow, conversation_id: str, root_task_context: dict,
                             target_employee_ids: list[str],
                             planner_employee_id: str,
                             idempotency_key: str) -> dict:
    """Persist a TeamRun with kanban_orchestration mode, create root TeamTask.

    Returns {run_id, status, stream_url, events_url, runtime_handle}.
    """
    # Idempotency check
    existing = _find_run_by_idempotency(uow, idempotency_key)
    if existing is not None:
        run = uow.team_runs().get_by_id(existing)
        if run is not None:
            root_task = _find_root_task(uow, run.id)
            binding = uow.runtime_bindings().get_by_owner("team_run", run.id)
            return {
                "run_id": run.id,
                "status": run.status,
                "stream_url": f"/api/team/runs/{run.id}/stream?cursor=0",
                "events_url": f"/api/team/runs/{run.id}/events?cursor=0",
                "runtime_handle": {
                    "kind": binding.runtime_kind if binding else None,
                    "session_id": binding.runtime_session_id if binding else None,
                    "task_id": binding.runtime_task_id if binding else None,
                },
                "root_team_task_id": root_task.id if root_task else None,
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
        trigger_type="group_message",
        execution_mode="kanban_orchestration",
        status="queued",
        planner_employee_id=planner_employee_id,
        idempotency_key=idempotency_key,
        input_message_json=json.dumps(root_task_context),
        created_by=planner_employee_id or "system",
    )
    uow.team_runs().create(run)

    # Create root TeamTask
    task_title = root_task_context.get("title", "Orchestration task")
    task_description = root_task_context.get("description", "")
    task_input = root_task_context.get("input", root_task_context)
    root_task_id = f"task_{uuid.uuid4().hex[:12]}"
    task = TeamTask(
        id=root_task_id,
        run_id=run_id,
        title=task_title,
        description=task_description,
        assignee_employee_id=planner_employee_id,
        status="planned",
        sequence_no=1,
        depth=0,
        input_payload_json=json.dumps(task_input) if isinstance(task_input, dict) else str(task_input),
    )
    uow.team_tasks().create(task)

    # Link root task to run
    run.root_team_task_id = root_task_id
    # Persist the link via update_status which doesn't cover root_team_task_id...
    # We need to update it explicitly
    uow.cur.execute(
        "UPDATE team_run SET root_team_task_id=%s, updated_at=now() WHERE id=%s",
        (root_task_id, run_id),
    )

    # Update conversation mirror fields
    conv.latest_run_id = run_id
    uow.conversations().update_latest_run(conv.id, run_id, None, "")

    # Call gateway fake seam
    gw_request = {
        "run_id": run_id,
        "enterprise_id": enterprise_id,
        "planner_employee_id": planner_employee_id,
        "conversation_id": conversation_id,
        "root_task_context": root_task_context,
        "target_employee_ids": target_employee_ids,
        "execution_mode": "kanban_orchestration",
    }
    gw_response = submit_orchestration(gw_request)

    # Persist RuntimeBinding
    binding = RuntimeBinding(
        id=f"rb_{uuid.uuid4().hex[:12]}",
        enterprise_id=enterprise_id,
        owner_type="team_run",
        owner_id=run_id,
        profile_name=gw_response.runtime_handle.profile_name,
        runtime_kind="kanban_task",
        runtime_session_id=gw_response.runtime_handle.session_id,
        runtime_task_id=gw_response.runtime_handle.task_id,
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
            "kind": gw_response.runtime_handle.kind,
            "session_id": gw_response.runtime_handle.session_id,
            "task_id": gw_response.runtime_handle.task_id,
        },
        "root_team_task_id": root_task_id,
    }


def _find_run_by_idempotency(uow, idempotency_key: str) -> str | None:
    """Return run_id if a run with this idempotency_key exists, else None."""
    existing = uow.team_runs().get_by_idempotency_key(idempotency_key)
    return existing.id if existing else None


def _find_root_task(uow, run_id: str) -> TeamTask | None:
    """Return the root task for a run (depth=0), if any."""
    tasks = uow.team_tasks().list_by_run(run_id)
    for t in tasks:
        if t.depth == 0 and t.parent_team_task_id is None:
            return t
    return tasks[0] if tasks else None
