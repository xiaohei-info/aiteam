"""Cursor query helpers — event pagination and latest-event helpers.

Provides small wrappers around RunEventRepo that query services use
to fetch the latest event or paginated event lists.  Keeps raw SQL
out of query services.
"""

from __future__ import annotations

from ..domain.entities import RunEvent
from ..repositories.run_event_repo import RunEventRepo


def get_latest_event(event_repo: RunEventRepo, run_id: str) -> RunEvent | None:
    """Return the most recent event for a run (highest cursor_no)."""
    max_cursor = event_repo.get_max_cursor(run_id)
    if max_cursor == 0:
        return None
    events = event_repo.list_by_run(run_id, after_cursor=max_cursor - 1, limit=1)
    return events[0] if events else None


def get_latest_events_for_runs(
    event_repo: RunEventRepo, run_ids: set[str]
) -> dict[str, RunEvent | None]:
    """Batch-fetch the latest event for each run_id.

    Returns a dict mapping run_id → latest RunEvent (or None).
    """
    result: dict[str, RunEvent | None] = {}
    for rid in run_ids:
        max_cursor = event_repo.get_max_cursor(rid)
        if max_cursor == 0:
            result[rid] = None
            continue
        # Fetch the event at max_cursor.  list_by_run is cursor_no > after_cursor,
        # so after_cursor = max_cursor - 1  gets us exactly the last event.
        events = event_repo.list_by_run(rid, after_cursor=max_cursor - 1, limit=1)
        result[rid] = events[0] if events else None
    return result


def get_events_since(
    event_repo: RunEventRepo, run_id: str, since_cursor: int, limit: int = 50
) -> list[RunEvent]:
    """Return events with cursor_no > since_cursor, ordered ascending."""
    return event_repo.list_by_run(run_id, after_cursor=since_cursor, limit=limit)


def get_usage_events(
    event_repo: RunEventRepo, run_id: str
) -> list[RunEvent]:
    """Return all usage_recorded events for a run (used by billing aggregation)."""
    return event_repo.list_by_run(run_id, after_cursor=0, limit=500)
