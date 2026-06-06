"""Employee org assignment repository — persistence for P07 organization placement."""
from typing import Optional

from ..domain.entities import EmployeeOrgAssignment


class EmployeeOrgAssignmentRepo:
    def __init__(self, cur):
        self._cur = cur

    def get_by_id(self, assignment_id: str) -> Optional[EmployeeOrgAssignment]:
        self._cur.execute(
            "SELECT id, enterprise_id, employee_id, department_id, position_title, visibility_scope, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM employee_org_assignment WHERE id = %s AND deleted_at IS NULL",
            (assignment_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def get_by_employee_id(self, employee_id: str) -> Optional[EmployeeOrgAssignment]:
        self._cur.execute(
            "SELECT id, enterprise_id, employee_id, department_id, position_title, visibility_scope, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM employee_org_assignment WHERE employee_id = %s AND deleted_at IS NULL",
            (employee_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_enterprise(self, enterprise_id: str) -> list[EmployeeOrgAssignment]:
        self._cur.execute(
            "SELECT id, enterprise_id, employee_id, department_id, position_title, visibility_scope, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM employee_org_assignment WHERE enterprise_id = %s AND deleted_at IS NULL ORDER BY created_at, id",
            (enterprise_id,),
        )
        return [self._row_to_entity(row) for row in self._cur.fetchall()]

    def upsert(self, assignment: EmployeeOrgAssignment) -> EmployeeOrgAssignment:
        self._cur.execute(
            "INSERT INTO employee_org_assignment (id, enterprise_id, employee_id, department_id, position_title, visibility_scope, created_by, updated_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (id) DO UPDATE SET department_id = EXCLUDED.department_id, position_title = EXCLUDED.position_title, visibility_scope = EXCLUDED.visibility_scope, updated_by = EXCLUDED.updated_by, updated_at = now(), deleted_at = NULL",
            (
                assignment.id,
                assignment.enterprise_id,
                assignment.employee_id,
                assignment.department_id,
                assignment.position_title,
                assignment.visibility_scope,
                assignment.created_by or None,
                assignment.updated_by or None,
            ),
        )
        return assignment

    @staticmethod
    def _row_to_entity(row) -> EmployeeOrgAssignment:
        return EmployeeOrgAssignment(
            id=row[0],
            enterprise_id=row[1],
            employee_id=row[2],
            department_id=row[3],
            position_title=row[4] or "",
            visibility_scope=row[5] or "department",
            created_at=str(row[6]) if row[6] else "",
            updated_at=str(row[7]) if row[7] else "",
            created_by=row[8] or "",
            updated_by=row[9] or "",
            deleted_at=str(row[10]) if row[10] else None,
        )
