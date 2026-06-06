"""SolutionApplyRecord repository."""
import json
from typing import Optional

from ..domain.entities import SolutionApplyRecord


class SolutionApplyRecordRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, record: SolutionApplyRecord) -> SolutionApplyRecord:
        self._cur.execute(
            "INSERT INTO solution_apply_record (id, enterprise_id, solution_id, idempotency_key, mode, status, "
            "requested_by, department_id, created_employee_ids_json, created_knowledge_base_ids_json, "
            "error_code, error_message, created_by, updated_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s, %s)",
            (
                record.id,
                record.enterprise_id,
                record.solution_id,
                record.idempotency_key,
                record.mode,
                record.status,
                record.requested_by,
                record.department_id,
                record.created_employee_ids_json,
                record.created_knowledge_base_ids_json,
                record.error_code,
                record.error_message,
                record.created_by or None,
                record.updated_by or None,
            ),
        )
        return record

    def get_by_id(self, record_id: str) -> Optional[SolutionApplyRecord]:
        self._cur.execute(
            "SELECT id, enterprise_id, solution_id, idempotency_key, mode, status, requested_by, department_id, "
            "created_employee_ids_json, created_knowledge_base_ids_json, error_code, error_message, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM solution_apply_record WHERE id = %s",
            (record_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def get_by_idempotency_key(self, enterprise_id: str, solution_id: str, idempotency_key: str) -> Optional[SolutionApplyRecord]:
        self._cur.execute(
            "SELECT id, enterprise_id, solution_id, idempotency_key, mode, status, requested_by, department_id, "
            "created_employee_ids_json, created_knowledge_base_ids_json, error_code, error_message, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM solution_apply_record WHERE enterprise_id = %s AND solution_id = %s AND idempotency_key = %s "
            "AND deleted_at IS NULL",
            (enterprise_id, solution_id, idempotency_key),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_solution(self, solution_id: str) -> list[SolutionApplyRecord]:
        self._cur.execute(
            "SELECT id, enterprise_id, solution_id, idempotency_key, mode, status, requested_by, department_id, "
            "created_employee_ids_json, created_knowledge_base_ids_json, error_code, error_message, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM solution_apply_record WHERE solution_id = %s AND deleted_at IS NULL "
            "ORDER BY created_at DESC",
            (solution_id,),
        )
        return [self._row_to_entity(row) for row in self._cur.fetchall()]

    @staticmethod
    def _row_to_entity(row) -> SolutionApplyRecord:
        return SolutionApplyRecord(
            id=row[0],
            enterprise_id=row[1],
            solution_id=row[2],
            idempotency_key=row[3],
            mode=row[4],
            status=row[5],
            requested_by=row[6] or "",
            department_id=row[7],
            created_employee_ids_json=json.dumps(row[8], ensure_ascii=False) if isinstance(row[8], list) else (str(row[8]) if row[8] else "[]"),
            created_knowledge_base_ids_json=json.dumps(row[9], ensure_ascii=False) if isinstance(row[9], list) else (str(row[9]) if row[9] else "[]"),
            error_code=row[10],
            error_message=row[11],
            created_at=str(row[12]),
            updated_at=str(row[13]),
            created_by=row[14] or "",
            updated_by=row[15] or "",
            deleted_at=str(row[16]) if row[16] else None,
        )
