"""TeamTask repository — persistence for team_task table."""
from typing import Optional

from ..domain.entities import TeamTask


class TeamTaskRepo:
    """Repository for TeamTask entity backed by a psycopg cursor."""

    def __init__(self, cur):
        self._cur = cur

    def create(self, task: TeamTask) -> TeamTask:
        self._cur.execute(
            "INSERT INTO team_task (id, run_id, parent_team_task_id, title, "
            "description, assignee_employee_id, status, sequence_no, depth, "
            "input_payload_json, runtime_task_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (task.id, task.run_id, task.parent_team_task_id, task.title,
             task.description, task.assignee_employee_id, task.status,
             task.sequence_no, task.depth,
             task.input_payload_json, task.runtime_task_id),
        )
        return task

    def get_by_id(self, task_id: str) -> Optional[TeamTask]:
        self._cur.execute(
            "SELECT id, run_id, parent_team_task_id, title, description, "
            "assignee_employee_id, status, sequence_no, depth, "
            "input_payload_json, output_summary_json, runtime_task_id, "
            "started_at, finished_at, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM team_task WHERE id = %s",
            (task_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_run(self, run_id: str) -> list[TeamTask]:
        self._cur.execute(
            "SELECT id, run_id, parent_team_task_id, title, description, "
            "assignee_employee_id, status, sequence_no, depth, "
            "input_payload_json, output_summary_json, runtime_task_id, "
            "started_at, finished_at, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM team_task WHERE run_id = %s AND deleted_at IS NULL "
            "ORDER BY sequence_no",
            (run_id,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def get_by_runtime_task_id(self, run_id: str, runtime_task_id: str) -> Optional[TeamTask]:
        self._cur.execute(
            "SELECT id, run_id, parent_team_task_id, title, description, "
            "assignee_employee_id, status, sequence_no, depth, "
            "input_payload_json, output_summary_json, runtime_task_id, "
            "started_at, finished_at, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM team_task WHERE run_id = %s AND runtime_task_id = %s AND deleted_at IS NULL "
            "ORDER BY sequence_no LIMIT 1",
            (run_id, runtime_task_id),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def update_status(self, task: TeamTask) -> TeamTask:
        self._cur.execute(
            "UPDATE team_task SET parent_team_task_id=%s, title=%s, description=%s, "
            "assignee_employee_id=%s, status=%s, depth=%s, input_payload_json=%s, "
            "output_summary_json=%s, runtime_task_id=%s, started_at=%s, finished_at=%s, "
            "updated_at=now() WHERE id=%s",
            (task.parent_team_task_id, task.title or None, task.description,
             task.assignee_employee_id, task.status, task.depth,
             task.input_payload_json, task.output_summary_json,
             task.runtime_task_id,
             task.started_at or None, task.finished_at or None,
             task.id),
        )
        return task

    def delete(self, task_id: str) -> None:
        self._cur.execute(
            "UPDATE team_task SET deleted_at=now() WHERE id=%s",
            (task_id,),
        )

    @staticmethod
    def _row_to_entity(row) -> TeamTask:
        return TeamTask(
            id=row[0], run_id=row[1], parent_team_task_id=row[2],
            title=row[3] or "", description=row[4],
            assignee_employee_id=row[5],
            status=row[6], sequence_no=row[7] or 0, depth=row[8] or 0,
            input_payload_json=str(row[9]) if row[9] else None,
            output_summary_json=str(row[10]) if row[10] else None,
            runtime_task_id=row[11],
            started_at=str(row[12]) if row[12] else "",
            finished_at=str(row[13]) if row[13] else "",
            created_at=str(row[14]), updated_at=str(row[15]),
            created_by=row[16] or "", updated_by=row[17] or "",
            deleted_at=str(row[18]) if row[18] else None,
        )
