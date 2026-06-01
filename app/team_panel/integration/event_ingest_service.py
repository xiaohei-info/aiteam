"""Event ingest service — receives RunTimelineEvent from Gateway, persists to
run_event, updates runtime_binding cursor, and refreshes read-side mirrors.

Design: §6 of Team Panel内部服务与聚合视图详细设计.
"""

import json
import uuid

from ..domain.entities import RunEvent, TeamTask


_TERMINAL_EVENTS = frozenset({"run_succeeded", "run_failed", "run_cancelled"})
_TASK_EVENTS = frozenset({"task_created", "task_started", "task_completed", "task_failed"})


def ingest_timeline_event(uow, event: dict) -> dict:
    """Receive a RunTimelineEvent from Gateway and write it through."""
    enterprise_id = event.get("enterprise_id", "")
    run_id = event.get("run_id", "")
    cursor_no = event.get("cursor_no", 0)
    event_type = event.get("event_type", "")
    source_type = event.get("source_type", "")
    source_id = event.get("source_id", "")

    if not enterprise_id or not run_id or not event_type:
        raise ValueError(
            "event must contain enterprise_id, run_id, and event_type"
        )

    run_event = RunEvent(
        id=event.get("id", f"evt_{uuid.uuid4().hex[:8]}"),
        enterprise_id=enterprise_id,
        run_id=run_id,
        cursor_no=cursor_no,
        event_type=event_type,
        source_type=source_type,
        source_id=source_id,
        team_task_id=event.get("team_task_id"),
        employee_id=event.get("employee_id"),
        event_ts=event.get("event_ts", ""),
        preview_text=event.get("preview_text", ""),
        payload_json=_serialize_payload(event.get("payload_json")),
    )
    uow.run_events().create(run_event)

    is_terminal = event_type in _TERMINAL_EVENTS

    binding = uow.runtime_bindings().get_by_owner("team_run", run_id)
    if binding is not None:
        if cursor_no > binding.event_cursor:
            binding.event_cursor = cursor_no
        runtime_source_cursor = event.get("runtime_source_cursor")
        if runtime_source_cursor is not None:
            binding.runtime_source_cursor = runtime_source_cursor
        binding.mark_synced()
        uow.runtime_bindings().update_sync(binding)

    if event_type in _TASK_EVENTS:
        _apply_task_mirror(uow, run_id, event_type, event)

    if is_terminal:
        _apply_terminal_mirror(uow, run_id, event_type, event)

    return {
        "ingested": True,
        "terminal": is_terminal,
        "cursor": cursor_no,
    }


def _apply_terminal_mirror(uow, run_id: str, event_type: str, event: dict) -> None:
    """Mirror terminal run status into team_run and conversation read-side."""
    run = uow.team_runs().get_by_id(run_id)
    if run is None:
        return

    preview = event.get("preview_text", "") or ""
    payload = _deserialize_payload(event.get("payload_json"))

    if event_type == "run_succeeded":
        if run.status not in run._TERMINAL:
            run.mark_succeeded()
        if not run.result_summary_json and preview:
            run.result_summary_json = json.dumps({"summary": preview})
        elif payload and not run.result_summary_json:
            run.result_summary_json = json.dumps(payload)
    elif event_type == "run_failed":
        if run.status not in run._TERMINAL:
            error_code = event.get("error_code", "")
            error_message = event.get("error_message", "")
            if payload:
                if not error_code:
                    error_code = payload.get("error_code", "")
                if not error_message:
                    error_message = payload.get("error_message", "")
            run.mark_failed(
                error_code=error_code or "run_failed",
                error_message=error_message or preview or "Run failed",
            )
        if not run.result_summary_json and preview:
            run.result_summary_json = json.dumps({"error_summary": preview})
    elif event_type == "run_cancelled":
        if run.status not in run._TERMINAL:
            run.cancel()
        if not run.result_summary_json and preview:
            run.result_summary_json = json.dumps({"cancel_summary": preview})

    event_ts = event.get("event_ts", "")
    if not run.finished_at:
        run.finished_at = event_ts

    uow.team_runs().update_status(run)
    _update_scheduled_job_mirror(uow, run, event_type, event_ts)

    if run.conversation_id:
        conv = uow.conversations().get_by_id(run.conversation_id)
        if conv is not None:
            uow.conversations().update_latest_run(
                run.conversation_id,
                run_id,
                None,
                preview or conv.last_message_preview or "",
            )


def _update_scheduled_job_mirror(uow, run, event_type: str, event_ts: str) -> None:
    if not run.scheduled_job_id:
        return

    job = uow.scheduled_jobs().get_by_id(run.scheduled_job_id)
    if job is None:
        return

    if event_ts:
        job.last_run_at = event_ts

    if event_type == "run_succeeded":
        job.last_run_status = "succeeded"
        if event_ts:
            job.last_success_at = event_ts
        job.record_success()
    elif event_type == "run_failed":
        job.last_run_status = "failed"
        job.record_failure()
    elif event_type == "run_cancelled":
        job.last_run_status = "cancelled"

    uow.scheduled_jobs().update_status(job)


def _apply_task_mirror(uow, run_id: str, event_type: str, event: dict) -> None:
    run = uow.team_runs().get_by_id(run_id)
    if run is None or run.execution_mode != "kanban_orchestration":
        return

    runtime_task_id = event.get("source_id")
    if not runtime_task_id:
        return

    payload = _deserialize_payload(event.get("payload_json"))
    task_repo = uow.team_tasks()
    task = task_repo.get_by_runtime_task_id(run_id, runtime_task_id)

    if task is None:
        if event_type != "task_created":
            return
        task = TeamTask(
            id=f"task_{uuid.uuid4().hex[:12]}",
            run_id=run_id,
            parent_team_task_id=_resolve_parent_team_task_id(uow, run, payload),
            title=_task_title_from_event(event, payload),
            description=_task_description_from_payload(payload),
            assignee_employee_id=event.get("employee_id") or _payload_value(payload, "employee_id", "assignee_employee_id"),
            status="planned",
            sequence_no=_next_task_sequence(uow, run_id),
            depth=_resolve_task_depth(uow, run, payload),
            input_payload_json=json.dumps(payload) if payload else None,
            runtime_task_id=runtime_task_id,
        )
        task_repo.create(task)
    else:
        if payload:
            task.input_payload_json = json.dumps(payload)
        parent_runtime_task_id = _payload_value(payload, "parent_task_id", "parent_runtime_task_id")
        if parent_runtime_task_id:
            resolved_parent_team_task_id = _resolve_parent_team_task_id(uow, run, payload)
            if resolved_parent_team_task_id is not None:
                task.parent_team_task_id = resolved_parent_team_task_id
            task.depth = _resolve_task_depth(uow, run, payload)
        assignee_employee_id = event.get("employee_id") or _payload_value(payload, "employee_id", "assignee_employee_id")
        if assignee_employee_id:
            task.assignee_employee_id = assignee_employee_id
        title = _payload_value(payload, "title", "task_title", "name")
        if isinstance(title, str) and title.strip():
            task.title = title.strip()
        elif not task.title:
            task.title = _task_title_from_event(event, payload)
        description = _task_description_from_payload(payload)
        if description:
            task.description = description

    if event_type == "task_created":
        if task.status == "planned":
            task.queue()
    elif event_type == "task_started":
        if task.status == "planned":
            task.queue()
        if task.status in ("queued", "waiting_deps"):
            task.start_running()
        if not task.started_at:
            task.started_at = event.get("event_ts", "")
    elif event_type == "task_completed":
        if not task.is_terminal():
            task.mark_succeeded()
        if event.get("preview_text"):
            task.output_summary_json = json.dumps({"summary": event["preview_text"]})
        elif payload:
            task.output_summary_json = json.dumps(payload)
        if not task.finished_at:
            task.finished_at = event.get("event_ts", "")
    elif event_type == "task_failed":
        if not task.is_terminal():
            task.mark_failed()
        if event.get("preview_text"):
            task.output_summary_json = json.dumps({"error_summary": event["preview_text"]})
        elif payload:
            task.output_summary_json = json.dumps(payload)
        if not task.finished_at:
            task.finished_at = event.get("event_ts", "")

    task_repo.update_status(task)


def _resolve_parent_team_task_id(uow, run, payload: dict | None) -> str | None:
    parent_runtime_task_id = _payload_value(payload, "parent_task_id", "parent_runtime_task_id")
    if not parent_runtime_task_id:
        return None
    if parent_runtime_task_id == _root_runtime_task_id(uow, run):
        return run.root_team_task_id
    parent = uow.team_tasks().get_by_runtime_task_id(run.id, parent_runtime_task_id)
    return parent.id if parent is not None else None


def _resolve_task_depth(uow, run, payload: dict | None) -> int:
    parent_runtime_task_id = _payload_value(payload, "parent_task_id", "parent_runtime_task_id")
    if not parent_runtime_task_id:
        return 0
    if parent_runtime_task_id == _root_runtime_task_id(uow, run):
        return 1
    parent = uow.team_tasks().get_by_runtime_task_id(run.id, parent_runtime_task_id)
    if parent is None:
        return 1
    return parent.depth + 1


def _root_runtime_task_id(uow, run) -> str | None:
    binding = uow.runtime_bindings().get_by_owner("team_run", run.id)
    return binding.runtime_task_id if binding is not None else None


def _next_task_sequence(uow, run_id: str) -> int:
    tasks = uow.team_tasks().list_by_run(run_id)
    return max((task.sequence_no for task in tasks), default=0) + 1


def _task_title_from_event(event: dict, payload: dict | None) -> str:
    if payload:
        for key in ("title", "task_title", "name"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    preview = event.get("preview_text", "")
    return preview.strip() if isinstance(preview, str) else ""


def _task_description_from_payload(payload: dict | None) -> str | None:
    if not payload:
        return None
    for key in ("description", "task_description"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _payload_value(payload: dict | None, *keys: str):
    if not payload:
        return None
    for key in keys:
        value = payload.get(key)
        if value not in (None, ""):
            return value
    return None


def _deserialize_payload(payload):
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (json.JSONDecodeError, TypeError):
            payload = None
    return payload if isinstance(payload, dict) else None


def _serialize_payload(payload):
    """Normalize payload to a JSON string for persistence."""
    if payload is None:
        return "{}"
    if isinstance(payload, str):
        return payload
    try:
        return json.dumps(payload)
    except (TypeError, ValueError):
        return "{}"
