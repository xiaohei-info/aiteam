"""Department repository — persistence for organization departments."""
from typing import Optional

from ..domain.entities import Department


class DepartmentRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, department: Department) -> Department:
        self._cur.execute(
            "INSERT INTO department (id, enterprise_id, parent_id, name, leader_user_id, visibility_scope, sort_order, created_by, updated_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                department.id,
                department.enterprise_id,
                department.parent_id,
                department.name,
                department.leader_user_id,
                department.visibility_scope,
                department.sort_order,
                department.created_by or None,
                department.updated_by or None,
            ),
        )
        return department

    def get_by_id(self, department_id: str) -> Optional[Department]:
        self._cur.execute(
            "SELECT id, enterprise_id, parent_id, name, leader_user_id, visibility_scope, sort_order, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM department WHERE id = %s AND deleted_at IS NULL",
            (department_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_enterprise(self, enterprise_id: str) -> list[Department]:
        self._cur.execute(
            "SELECT id, enterprise_id, parent_id, name, leader_user_id, visibility_scope, sort_order, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM department WHERE enterprise_id = %s AND deleted_at IS NULL ORDER BY sort_order, created_at, id",
            (enterprise_id,),
        )
        return [self._row_to_entity(row) for row in self._cur.fetchall()]

    @staticmethod
    def _row_to_entity(row) -> Department:
        return Department(
            id=row[0],
            enterprise_id=row[1],
            parent_id=row[2],
            name=row[3],
            leader_user_id=row[4],
            visibility_scope=row[5] or "enterprise",
            sort_order=row[6] or 0,
            created_at=str(row[7]) if row[7] else "",
            updated_at=str(row[8]) if row[8] else "",
            created_by=row[9] or "",
            updated_by=row[10] or "",
            deleted_at=str(row[11]) if row[11] else None,
        )
