"""Gateway reconcile helpers for cursor catch-up and stale terminal-state detection."""

from __future__ import annotations

import json
import uuid
from typing import Iterable, Mapping, Optional

from team_panel.domain.entities import RunEvent
from team_panel.transactions.uow import UnitOfWork

_TERMINAL_EVENT_TYPES = frozenset({"run_succeeded", "run_failed", "run_cancelled"})


def catch_up_events(
    uow: UnitOfWork,
    run_id: str,
    runtime_events: Iterable[Mapping[str, object]],
) -> int:
    """Persist missed runtime events newer than the binding cursor and advance it."""
    binding_repo = uow.runtime_bindings()
    event_repo = uow.run_events()

    binding = binding_repo.get_by_owner("team_run", run_id)
    if binding is None:
        raise ValueError(f"No runtime binding for run {run_id}")

    accepted_cursor = binding.event_cursor
    for raw_event in runtime_events:
        cursor = _coerce_cursor(raw_event.get("event_cursor"))
        if cursor <= accepted_cursor:
            continue

        event = _runtime_event_to_run_event(binding.enterprise_id, run_id, raw_event)
        event_repo.create(event)
        accepted_cursor = cursor

    if accepted_cursor > binding.event_cursor:
        binding.advance_cursor(accepted_cursor)
        binding.mark_synced()
        binding_repo.update_sync(binding)

    return accepted_cursor


def check_run_terminal_state(uow: UnitOfWork, run_id: str) -> Optional[str]:
    """Return stale terminal status when timeline already shows a terminal event."""
    latest = uow.run_events().get_latest_for_run(run_id)
    if latest is None:
        return None
    if latest.event_type in _TERMINAL_EVENT_TYPES:
        return latest.event_type
    return None


def reconcile_stale_run(uow: UnitOfWork, run_id: str) -> Optional[str]:
    """Align TeamRun status with terminal timeline truth when control-plane lags."""
    terminal_event_type = check_run_terminal_state(uow, run_id)
    if terminal_event_type is None:
        return None

    run_repo = uow.team_runs()
    run = run_repo.get_by_id(run_id)
    if run is None:
        raise ValueError(f"No team_run found for run {run_id}")
    if run.is_terminal():
        return run.status

    if terminal_event_type == "run_succeeded":
        run.mark_succeeded()
    elif terminal_event_type == "run_failed":
        run.mark_failed()
    else:
        run.cancel()
    run_repo.update_status(run)
    return run.status


def reconcile_interrupted_run(uow: UnitOfWork, run_id: str, *, reason: str) -> Optional[str]:
    """Fail a non-terminal run whose in-process executor can no longer finish."""
    run_repo = uow.team_runs()
    run = run_repo.get_by_id(run_id)
    if run is None:
        raise ValueError(f"No team_run found for run {run_id}")
    if run.is_terminal():
        return run.status

    terminal_event_type = check_run_terminal_state(uow, run_id)
    if terminal_event_type is not None:
        return reconcile_stale_run(uow, run_id)

    from team_panel.integration.event_ingest_service import ingest_timeline_event

    cursor = uow.run_events().get_max_cursor(run_id) + 1
    ingest_timeline_event(uow, {
        "id": f"evt_{run_id}_interrupted",
        "enterprise_id": run.enterprise_id,
        "run_id": run_id,
        "cursor_no": cursor,
        "event_type": "run_failed",
        "source_type": "gateway",
        "source_id": "reconcile",
        "employee_id": run.entry_employee_id,
        "preview_text": reason,
        "error_code": "INTERRUPTED",
        "error_message": reason,
        "payload_json": {
            "error_code": "INTERRUPTED",
            "error_message": reason,
        },
    })
    return "failed"


def reconcile_interrupted_runs(
    uow: UnitOfWork,
    *,
    interrupted_before: str,
    reason: str,
) -> list[str]:
    """Fail non-terminal TeamRuns left behind by a previous server process."""
    uow.cur.execute(
        "SELECT id FROM team_run "
        "WHERE status IN ('queued','routing','submitting','running','waiting_human') "
        "AND deleted_at IS NULL AND updated_at < %s "
        "ORDER BY updated_at ASC",
        (interrupted_before,),
    )
    run_ids = [row[0] for row in uow.cur.fetchall()]
    recovered: list[str] = []
    for run_id in run_ids:
        status = reconcile_interrupted_run(uow, run_id, reason=reason)
        if status == "failed":
            recovered.append(run_id)
    return recovered


def _runtime_event_to_run_event(
    enterprise_id: str,
    run_id: str,
    raw_event: Mapping[str, object],
) -> RunEvent:
    cursor = _coerce_cursor(raw_event.get("event_cursor"))
    event_id = str(raw_event.get("event_id") or f"evt_{run_id}_{cursor}_{uuid.uuid4().hex[:8]}")
    payload = raw_event.get("payload")
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        raise ValueError("runtime event payload must be a dict")

    return RunEvent(
        id=event_id,
        enterprise_id=enterprise_id,
        run_id=run_id,
        cursor_no=cursor,
        event_type=str(raw_event.get("event_type") or "error"),
        source_type=str(raw_event.get("source_type") or "gateway"),
        source_id=str(raw_event.get("source_id") or run_id),
        employee_id=_optional_str(raw_event.get("employee_id")),
        event_ts=str(raw_event.get("event_ts") or ""),
        preview_text=str(raw_event.get("preview") or ""),
        payload_json=json.dumps(payload, ensure_ascii=False),
    )


def _coerce_cursor(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError("runtime event_cursor must be an int or numeric string")
    return int(value)


def _optional_str(value: object) -> Optional[str]:
    if value in (None, ""):
        return None
    return str(value)
