"""RunEvent repository — persistence for run_event table.

Supports dedupe via ON CONFLICT (run_id, cursor_no) DO NOTHING,
cursor-based pagination, and bulk ingestion.
"""

from typing import Optional
import json

from ..domain.entities import RunEvent


class RunEventRepo:
    """Repository for RunEvent entity backed by a psycopg cursor."""

    def __init__(self, cur):
        self._cur = cur

    def create(self, event: RunEvent) -> RunEvent:
        """Insert a single event; skips silently on cursor_no conflict (dedupe).

        event_ts is omitted when falsy so PostgreSQL can apply DEFAULT now().
        """
        cols = ["id", "enterprise_id", "run_id", "team_task_id",
                "cursor_no", "event_type", "source_type", "source_id",
                "employee_id"]
        vals = [event.id, event.enterprise_id, event.run_id, event.team_task_id,
                event.cursor_no, event.event_type, event.source_type,
                event.source_id, event.employee_id]

        if event.event_ts:
            cols.append("event_ts")
            vals.append(event.event_ts)
        if event.preview_text:
            cols.append("preview_text")
            vals.append(event.preview_text)
        cols.append("payload_json")
        vals.append(event.payload_json)

        placeholders = ", ".join(["%s"] * len(vals))
        col_spec = ", ".join(cols)
        self._cur.execute(
            f"INSERT INTO run_event ({col_spec}) "
            f"VALUES ({placeholders}) "
            "ON CONFLICT (run_id, cursor_no) DO NOTHING",
            vals,
        )
        return event

    def get_by_id(self, event_id: str) -> Optional[RunEvent]:
        self._cur.execute(
            "SELECT id, enterprise_id, run_id, team_task_id, cursor_no, "
            "event_type, source_type, source_id, employee_id, event_ts, "
            "preview_text, payload_json, created_at, updated_at "
            "FROM run_event WHERE id = %s",
            (event_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_run(self, run_id: str, *,
                    after_cursor: int = 0,
                    limit: int = 100) -> list[RunEvent]:
        """Cursor-based pagination: events with cursor_no > after_cursor, ordered ASC."""
        self._cur.execute(
            "SELECT id, enterprise_id, run_id, team_task_id, cursor_no, "
            "event_type, source_type, source_id, employee_id, event_ts, "
            "preview_text, payload_json, created_at, updated_at "
            "FROM run_event WHERE run_id = %s AND cursor_no > %s "
            "ORDER BY cursor_no ASC LIMIT %s",
            (run_id, after_cursor, limit),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def get_max_cursor(self, run_id: str) -> int:
        """Return the max cursor_no for a given run, or 0 if no events."""
        self._cur.execute(
            "SELECT COALESCE(MAX(cursor_no), 0) FROM run_event WHERE run_id = %s",
            (run_id,),
        )
        row = self._cur.fetchone()
        return row[0] if row else 0

    def get_latest_for_run(self, run_id: str) -> Optional[RunEvent]:
        """Return the latest event for a run by descending cursor_no."""
        self._cur.execute(
            "SELECT id, enterprise_id, run_id, team_task_id, cursor_no, "
            "event_type, source_type, source_id, employee_id, event_ts, "
            "preview_text, payload_json, created_at, updated_at "
            "FROM run_event WHERE run_id = %s "
            "ORDER BY cursor_no DESC LIMIT 1",
            (run_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    @staticmethod
    def _row_to_entity(row) -> RunEvent:
        return RunEvent(
            id=row[0], enterprise_id=row[1],
            run_id=row[2], team_task_id=row[3],
            cursor_no=row[4],
            event_type=row[5],
            source_type=row[6], source_id=row[7],
            employee_id=row[8],
            event_ts=str(row[9]) if row[9] else "",
            preview_text=row[10] or "",
            payload_json=json.dumps(row[11], ensure_ascii=False) if row[11] else "{}",
            created_at=str(row[12]), updated_at=str(row[13]),
        )
