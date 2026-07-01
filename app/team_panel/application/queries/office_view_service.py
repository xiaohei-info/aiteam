"""Office aggregation queries for P09 office scene/feed surfaces."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from ...transactions.uow import UnitOfWork

_ACTIVE_RUN_STATUSES = {"queued", "routing", "submitting", "running", "waiting_human"}
_QUEUE_RUN_STATUSES = {"queued", "routing", "submitting"}
_ACTIVE_JOB_STATUSES = {"enabled", "error"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _event_payload_preview(run) -> str:
    if not run.result_summary_json:
        return ""
    try:
        payload = json.loads(run.result_summary_json)
    except (TypeError, ValueError):
        return ""
    if not isinstance(payload, dict):
        return ""
    for key in ("headline", "summary", "preview", "result", "text"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _presence_state(employee_status: str, run_status: str | None, latest_event_type: str | None) -> str:
    if employee_status in {"archived", "provisioning_failed", "draft"}:
        return "offline"
    if employee_status == "paused":
        return "paused"
    if employee_status == "provisioning":
        return "provisioning"
    if run_status == "waiting_human":
        return "waiting_reply"
    if run_status in _QUEUE_RUN_STATUSES:
        return "queued"
    if run_status == "running":
        if latest_event_type == "message_delta":
            return "streaming"
        return "busy"
    return "idle"


def _job_presence_state(employee_status: str, job_status: str | None, last_run_status: str | None) -> str:
    if employee_status in {"archived", "provisioning_failed", "draft"}:
        return "offline"
    if employee_status == "paused":
        return "paused"
    if employee_status == "provisioning":
        return "provisioning"
    if job_status == "error":
        return "error"
    if last_run_status == "failed":
        return "error"
    if job_status == "enabled":
        return "scheduled"
    return "idle"


def _conversation_target(conversation) -> str:
    if not conversation:
        return ""
    prefix = "/app/group" if conversation.type == "group" else "/app/chat"
    return f"{prefix}/{conversation.id}"


def get_office_scene(uow: UnitOfWork, enterprise_id: str) -> dict:
    employees = uow.employees().list_by_enterprise(enterprise_id)
    conversations = {conv.id: conv for conv in uow.conversations().list_by_enterprise(enterprise_id)}
    runs = uow.team_runs().list_by_enterprise(enterprise_id)

    runs_by_employee: dict[str, list] = {}
    for run in runs:
        if not run.entry_employee_id:
            continue
        runs_by_employee.setdefault(run.entry_employee_id, []).append(run)

    active_runs = [run for run in runs if run.status in _ACTIVE_RUN_STATUSES]
    summary = {
        "online_employee_count": sum(1 for employee in employees if employee.status == "active"),
        "busy_employee_count": 0,
        "running_task_count": sum(1 for run in active_runs if run.status == "running"),
        "queue_depth": sum(1 for run in active_runs if run.status in _QUEUE_RUN_STATUSES),
        "waiting_reply_count": sum(1 for run in active_runs if run.status == "waiting_human"),
    }

    seats = []
    max_event_cursor = 0
    for employee in employees:
        employee_runs = runs_by_employee.get(employee.id, [])
        latest_run = employee_runs[0] if employee_runs else None
        latest_event = uow.run_events().get_latest_for_run(latest_run.id) if latest_run else None
        latest_conversation = conversations.get(latest_run.conversation_id) if latest_run and latest_run.conversation_id else None
        preview = ""
        if latest_event and latest_event.preview_text:
            preview = latest_event.preview_text
        elif latest_conversation and latest_conversation.last_message_preview:
            preview = latest_conversation.last_message_preview
        elif latest_run:
            preview = _event_payload_preview(latest_run)
        state = _presence_state(
            employee.status,
            latest_run.status if latest_run else None,
            latest_event.event_type if latest_event else None,
        )
        if state in {"busy", "streaming", "queued", "waiting_reply"}:
            summary["busy_employee_count"] += 1
        event_cursor = latest_event.cursor_no if latest_event else 0
        max_event_cursor = max(max_event_cursor, event_cursor)
        seats.append(
            {
                "seat_id": f"seat_{employee.id}",
                "employee_id": employee.id,
                "display_name": employee.display_name,
                "role_name": employee.role_name,
                "avatar_url": employee.avatar_url,
                "status": employee.status,
                "presence": {
                    "state": state,
                    "current_run_id": latest_run.id if latest_run else None,
                    "conversation_id": latest_run.conversation_id if latest_run else None,
                    "conversation_type": latest_conversation.type if latest_conversation else None,
                    "navigation_target": _conversation_target(latest_conversation),
                    "queue_depth": len([run for run in employee_runs if run.status in _ACTIVE_RUN_STATUSES]),
                    "last_response_at": latest_event.event_ts if latest_event else (latest_run.updated_at if latest_run else None),
                    "current_task": preview or None,
                    "latest_event_cursor": event_cursor,
                    "events_url": f"/api/team/runs/{latest_run.id}/events?cursor={event_cursor}" if latest_run else None,
                },
            }
        )

    return {
        "enterprise_id": enterprise_id,
        "generated_at": _now_iso(),
        "generated_cursor": max_event_cursor,
        "refresh_hint_ms": 5000,
        "summary": summary,
        "seats": seats,
    }


def _job_preview(job) -> str:
    name = (job.name or "").strip()
    goal = (job.goal or "").strip()
    if name and goal:
        return f"{name}: {goal}"
    return name or goal or ""


def get_office_feed(uow: UnitOfWork, enterprise_id: str, *, limit: int = 20) -> dict:
    employees = {employee.id: employee for employee in uow.employees().list_by_enterprise(enterprise_id)}
    conversations = {conv.id: conv for conv in uow.conversations().list_by_enterprise(enterprise_id)}
    runs = uow.team_runs().list_by_enterprise(enterprise_id)
    jobs = [job for job in uow.scheduled_jobs().list_by_enterprise(enterprise_id) if job.status in _ACTIVE_JOB_STATUSES]

    items: list[dict] = []
    queue: dict[str, int] = {"queued": 0, "running": 0, "waiting_human": 0, "failed": 0}
    max_event_cursor = 0

    for run in runs:
        latest_event = uow.run_events().get_latest_for_run(run.id)
        employee = employees.get(run.entry_employee_id or "")
        conversation = conversations.get(run.conversation_id or "")
        preview = ""
        if latest_event and latest_event.preview_text:
            preview = latest_event.preview_text
        elif conversation and conversation.last_message_preview:
            preview = conversation.last_message_preview
        else:
            preview = _event_payload_preview(run)
        if run.status in queue:
            queue[run.status] += 1
        event_cursor = latest_event.cursor_no if latest_event else 0
        max_event_cursor = max(max_event_cursor, event_cursor)
        event_ts = latest_event.event_ts if latest_event else (run.updated_at or run.created_at or _now_iso())
        items.append(
            {
                "run_id": run.id,
                "conversation_id": run.conversation_id,
                "conv_type": conversation.type if conversation else "private",
                "navigation_target": _conversation_target(conversation),
                "employee_id": run.entry_employee_id,
                "employee_display_name": employee.display_name if employee else None,
                "status": run.status,
                "event_type": latest_event.event_type if latest_event else "run_status",
                "event_ts": event_ts,
                "preview": preview,
                "display_state": _presence_state(
                    employee.status if employee else "active",
                    run.status,
                    latest_event.event_type if latest_event else None,
                ),
                "latest_event_cursor": event_cursor,
                "events_url": f"/api/team/runs/{run.id}/events?cursor={event_cursor}",
                "source": "run",
                "_sort_ts": event_ts,
            }
        )

    for job in jobs:
        employee = employees.get(job.employee_id or "")
        preview = _job_preview(job)
        last_run_status = job.last_run_status
        event_ts = job.last_run_at or job.updated_at or job.created_at or _now_iso()
        max_event_cursor = max(max_event_cursor, 1 if job.last_run_at else 0)
        if last_run_status == "failed":
            queue["failed"] += 1
        items.append(
            {
                "run_id": f"job_{job.id}",
                "conversation_id": None,
                "conv_type": "private",
                "navigation_target": None,
                "employee_id": job.employee_id,
                "employee_display_name": employee.display_name if employee else None,
                "status": last_run_status or job.status,
                "event_type": f"job_{last_run_status or job.status}",
                "event_ts": event_ts,
                "preview": preview,
                "display_state": _job_presence_state(
                    employee.status if employee else "active",
                    job.status,
                    last_run_status,
                ),
                "latest_event_cursor": 1 if job.last_run_at else 0,
                "events_url": None,
                "source": "job",
                "job_id": job.id,
                "job_name": job.name or "",
                "job_schedule": job.schedule_expr or "",
                "_sort_ts": event_ts,
            }
        )

    items.sort(key=lambda item: item["_sort_ts"], reverse=True)
    items = items[:limit]
    for item in items:
        item.pop("_sort_ts", None)

    return {
        "enterprise_id": enterprise_id,
        "generated_at": _now_iso(),
        "generated_cursor": max_event_cursor,
        "refresh_hint_ms": 5000,
        "items": items,
        "queue": queue,
        "billing_snapshot": {"total_tokens": 0, "total_cost_cents": 0},
    }
