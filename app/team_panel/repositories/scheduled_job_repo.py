"""ScheduledJob repository — persistence for scheduled_job table."""

from typing import Optional

from ..domain.entities import ScheduledJob


class ScheduledJobRepo:
    """Repository for ScheduledJob entity backed by a psycopg cursor."""

    def __init__(self, cur):
        self._cur = cur

    def create(self, job: ScheduledJob) -> ScheduledJob:
        self._cur.execute(
            "INSERT INTO scheduled_job (id, enterprise_id, employee_id, name, goal, "
            "schedule_expr, status, max_consecutive_failures, consecutive_failures, "
            "last_run_status, last_run_at, last_success_at, runtime_job_id, "
            "notification_policy_json, created_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (job.id, job.enterprise_id, job.employee_id, job.name, job.goal,
             job.schedule_expr, job.status, job.max_consecutive_failures,
             job.consecutive_failures, job.last_run_status,
             job.last_run_at or None, job.last_success_at or None,
             job.runtime_job_id, job.notification_policy_json,
             job.created_by or None),
        )
        return job

    def get_by_id(self, job_id: str) -> Optional[ScheduledJob]:
        self._cur.execute(
            "SELECT id, enterprise_id, employee_id, name, goal, schedule_expr, "
            "status, max_consecutive_failures, consecutive_failures, "
            "last_run_status, last_run_at, last_success_at, runtime_job_id, "
            "notification_policy_json, created_at, updated_at, created_by, updated_by, "
            "deleted_at FROM scheduled_job WHERE id = %s",
            (job_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_enterprise(self, enterprise_id: str) -> list[ScheduledJob]:
        self._cur.execute(
            "SELECT id, enterprise_id, employee_id, name, goal, schedule_expr, "
            "status, max_consecutive_failures, consecutive_failures, "
            "last_run_status, last_run_at, last_success_at, runtime_job_id, "
            "notification_policy_json, created_at, updated_at, created_by, updated_by, "
            "deleted_at FROM scheduled_job WHERE enterprise_id = %s "
            "AND deleted_at IS NULL ORDER BY created_at DESC",
            (enterprise_id,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def list_by_employee(self, employee_id: str) -> list[ScheduledJob]:
        self._cur.execute(
            "SELECT id, enterprise_id, employee_id, name, goal, schedule_expr, "
            "status, max_consecutive_failures, consecutive_failures, "
            "last_run_status, last_run_at, last_success_at, runtime_job_id, "
            "notification_policy_json, created_at, updated_at, created_by, updated_by, "
            "deleted_at FROM scheduled_job WHERE employee_id = %s "
            "AND deleted_at IS NULL ORDER BY created_at DESC",
            (employee_id,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def update_status(self, job: ScheduledJob) -> ScheduledJob:
        self._cur.execute(
            "UPDATE scheduled_job SET status=%s, consecutive_failures=%s, "
            "last_run_status=%s, last_run_at=%s, last_success_at=%s, "
            "runtime_job_id=%s, updated_at=now() WHERE id=%s",
            (job.status, job.consecutive_failures,
             job.last_run_status,
             job.last_run_at or None, job.last_success_at or None,
             job.runtime_job_id, job.id),
        )
        return job

    def update(self, job: ScheduledJob) -> ScheduledJob:
        self._cur.execute(
            "UPDATE scheduled_job SET name=%s, goal=%s, schedule_expr=%s, status=%s, "
            "max_consecutive_failures=%s, consecutive_failures=%s, last_run_status=%s, "
            "last_run_at=%s, last_success_at=%s, runtime_job_id=%s, notification_policy_json=%s, "
            "updated_at=now() WHERE id=%s",
            (
                job.name,
                job.goal,
                job.schedule_expr,
                job.status,
                job.max_consecutive_failures,
                job.consecutive_failures,
                job.last_run_status,
                job.last_run_at or None,
                job.last_success_at or None,
                job.runtime_job_id,
                job.notification_policy_json,
                job.id,
            ),
        )
        return job

    def delete(self, job_id: str) -> None:
        self._cur.execute(
            "UPDATE scheduled_job SET deleted_at=now() WHERE id=%s",
            (job_id,),
        )

    @staticmethod
    def _row_to_entity(row) -> ScheduledJob:
        return ScheduledJob(
            id=row[0], enterprise_id=row[1], employee_id=row[2],
            name=row[3] or "", goal=row[4] or "",
            schedule_expr=row[5] or "",
            status=row[6],
            max_consecutive_failures=row[7],
            consecutive_failures=row[8],
            last_run_status=row[9],
            last_run_at=str(row[10]) if row[10] else "",
            last_success_at=str(row[11]) if row[11] else "",
            runtime_job_id=row[12],
            notification_policy_json=str(row[13]) if row[13] else None,
            created_at=str(row[14]), updated_at=str(row[15]),
            created_by=row[16] or "", updated_by=row[17] or "",
            deleted_at=str(row[18]) if row[18] else None,
        )
