"""RecruitmentOrder repository."""
from typing import Optional

from ..domain.entities import RecruitmentOrder


class RecruitmentOrderRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, o: RecruitmentOrder) -> RecruitmentOrder:
        self._cur.execute(
            "INSERT INTO recruitment_order (id, enterprise_id, template_id, status, "
            "requested_by, created_employee_id, error_code, error_message, idempotency_key) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (o.id, o.enterprise_id, o.template_id, o.status,
             o.requested_by, o.created_employee_id, o.error_code, o.error_message,
             o.idempotency_key),
        )
        return o

    def get_by_id(self, order_id: str) -> Optional[RecruitmentOrder]:
        self._cur.execute(
            "SELECT id, enterprise_id, template_id, status, requested_by, "
            "created_employee_id, error_code, error_message, idempotency_key, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM recruitment_order WHERE id = %s",
            (order_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def get_by_idempotency_key(self, enterprise_id: str, idempotency_key: str) -> Optional[RecruitmentOrder]:
        self._cur.execute(
            "SELECT id, enterprise_id, template_id, status, requested_by, "
            "created_employee_id, error_code, error_message, idempotency_key, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM recruitment_order WHERE enterprise_id = %s AND idempotency_key = %s "
            "AND deleted_at IS NULL",
            (enterprise_id, idempotency_key),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_enterprise(self, enterprise_id: str) -> list[RecruitmentOrder]:
        self._cur.execute(
            "SELECT id, enterprise_id, template_id, status, requested_by, "
            "created_employee_id, error_code, error_message, idempotency_key, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM recruitment_order WHERE enterprise_id = %s AND deleted_at IS NULL "
            "ORDER BY created_at",
            (enterprise_id,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def update(self, o: RecruitmentOrder) -> RecruitmentOrder:
        self._cur.execute(
            "UPDATE recruitment_order SET status=%s, created_employee_id=%s, "
            "error_code=%s, error_message=%s, updated_at=now() WHERE id=%s",
            (o.status, o.created_employee_id, o.error_code, o.error_message, o.id),
        )
        return o

    def delete(self, order_id: str) -> None:
        self._cur.execute(
            "UPDATE recruitment_order SET deleted_at=now() WHERE id=%s",
            (order_id,),
        )

    @staticmethod
    def _row_to_entity(row) -> RecruitmentOrder:
        return RecruitmentOrder(
            id=row[0], enterprise_id=row[1], template_id=row[2],
            status=row[3], requested_by=row[4] or "",
            created_employee_id=row[5],
            error_code=row[6], error_message=row[7],
            idempotency_key=row[8],
            created_at=str(row[9]), updated_at=str(row[10]),
            created_by=row[11] or "", updated_by=row[12] or "",
            deleted_at=str(row[13]) if row[13] else None,
        )
