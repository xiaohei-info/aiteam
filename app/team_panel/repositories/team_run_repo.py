"""TeamRun repository — persistence for team_run table."""
import json as _json
from typing import Optional

from ..domain.entities import TeamRun


class TeamRunRepo:
    """Repository for TeamRun entity backed by a psycopg cursor."""

    def __init__(self, cur):
        self._cur = cur

    def create(self, run: TeamRun) -> TeamRun:
        self._cur.execute(
            "INSERT INTO team_run (id, enterprise_id, conversation_id, trigger_type, "
            "execution_mode, status, entry_employee_id, planner_employee_id, "
            "root_team_task_id, scheduled_job_id, idempotency_key, "
            "input_message_json, result_summary_json) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (run.id, run.enterprise_id, run.conversation_id, run.trigger_type,
             run.execution_mode, run.status, run.entry_employee_id,
             run.planner_employee_id, run.root_team_task_id,
             run.scheduled_job_id, run.idempotency_key,
             run.input_message_json, run.result_summary_json),
        )
        return run

    def get_by_id(self, run_id: str) -> Optional[TeamRun]:
        self._cur.execute(
            "SELECT id, enterprise_id, conversation_id, trigger_type, execution_mode, "
            "status, entry_employee_id, planner_employee_id, root_team_task_id, "
            "scheduled_job_id, idempotency_key, input_message_json, "
            "result_summary_json, started_at, finished_at, error_code, error_message, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM team_run WHERE id = %s",
            (run_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def get_by_idempotency_key(self, idempotency_key: str) -> Optional[TeamRun]:
        self._cur.execute(
            "SELECT id, enterprise_id, conversation_id, trigger_type, execution_mode, "
            "status, entry_employee_id, planner_employee_id, root_team_task_id, "
            "scheduled_job_id, idempotency_key, input_message_json, "
            "result_summary_json, started_at, finished_at, error_code, error_message, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM team_run WHERE idempotency_key = %s AND deleted_at IS NULL",
            (idempotency_key,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_enterprise(self, enterprise_id: str) -> list[TeamRun]:
        self._cur.execute(
            "SELECT id, enterprise_id, conversation_id, trigger_type, execution_mode, "
            "status, entry_employee_id, planner_employee_id, root_team_task_id, "
            "scheduled_job_id, idempotency_key, input_message_json, "
            "result_summary_json, started_at, finished_at, error_code, error_message, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM team_run WHERE enterprise_id = %s AND deleted_at IS NULL "
            "ORDER BY created_at DESC",
            (enterprise_id,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def list_by_conversation(self, conversation_id: str) -> list[TeamRun]:
        self._cur.execute(
            "SELECT id, enterprise_id, conversation_id, trigger_type, execution_mode, "
            "status, entry_employee_id, planner_employee_id, root_team_task_id, "
            "scheduled_job_id, idempotency_key, input_message_json, "
            "result_summary_json, started_at, finished_at, error_code, error_message, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM team_run WHERE conversation_id = %s AND deleted_at IS NULL "
            "ORDER BY created_at DESC",
            (conversation_id,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def update_status(self, run: TeamRun) -> TeamRun:
        self._cur.execute(
            "UPDATE team_run SET status=%s, result_summary_json=%s, "
            "started_at=%s, finished_at=%s, error_code=%s, error_message=%s, "
            "updated_at=now() WHERE id=%s",
            (run.status, run.result_summary_json,
             run.started_at or None, run.finished_at or None,
             run.error_code or None, run.error_message or None,
             run.id),
        )
        return run

    def delete(self, run_id: str) -> None:
        self._cur.execute(
            "UPDATE team_run SET deleted_at=now() WHERE id=%s",
            (run_id,),
        )

    @staticmethod
    def _row_to_entity(row) -> TeamRun:
        return TeamRun(
            id=row[0], enterprise_id=row[1], conversation_id=row[2],
            trigger_type=row[3], execution_mode=row[4],
            status=row[5], entry_employee_id=row[6],
            planner_employee_id=row[7], root_team_task_id=row[8],
            scheduled_job_id=row[9],
            idempotency_key=row[10] or "",
            input_message_json=_json.dumps(row[11]) if row[11] else "{}",
            result_summary_json=_json.dumps(row[12]) if row[12] else None,
            started_at=str(row[13]) if row[13] else "",
            finished_at=str(row[14]) if row[14] else "",
            error_code=row[15] or "",
            error_message=row[16] or "",
            created_at=str(row[17]), updated_at=str(row[18]),
            created_by=row[19] or "", updated_by=row[20] or "",
            deleted_at=str(row[21]) if row[21] else None,
        )
