"""EmployeeSkillBinding repository."""
from typing import Optional

from ..domain.entities import EmployeeSkillBinding


class EmployeeSkillBindingRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, b: EmployeeSkillBinding) -> EmployeeSkillBinding:
        self._cur.execute(
            "INSERT INTO employee_skill_binding (id, enterprise_id, employee_id, "
            "skill_code, enabled, source_type, binding_version, visibility) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (b.id, b.enterprise_id, b.employee_id, b.skill_code,
             b.enabled, b.source_type, b.binding_version, b.visibility),
        )
        return b

    def get_by_id(self, binding_id: str) -> Optional[EmployeeSkillBinding]:
        self._cur.execute(
            "SELECT id, enterprise_id, employee_id, skill_code, enabled, "
            "source_type, binding_version, visibility, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM employee_skill_binding WHERE id = %s",
            (binding_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_employee(self, employee_id: str) -> list[EmployeeSkillBinding]:
        self._cur.execute(
            "SELECT id, enterprise_id, employee_id, skill_code, enabled, "
            "source_type, binding_version, visibility, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM employee_skill_binding WHERE employee_id = %s AND deleted_at IS NULL "
            "ORDER BY skill_code",
            (employee_id,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def update(self, b: EmployeeSkillBinding) -> EmployeeSkillBinding:
        self._cur.execute(
            "UPDATE employee_skill_binding SET enabled=%s, binding_version=%s, "
            "updated_at=now() WHERE id=%s",
            (b.enabled, b.binding_version, b.id),
        )
        return b

    def delete(self, binding_id: str) -> None:
        self._cur.execute(
            "UPDATE employee_skill_binding SET deleted_at=now() WHERE id=%s",
            (binding_id,),
        )

    @staticmethod
    def _row_to_entity(row) -> EmployeeSkillBinding:
        return EmployeeSkillBinding(
            id=row[0], enterprise_id=row[1], employee_id=row[2],
            skill_code=row[3], enabled=row[4],
            source_type=row[5], binding_version=row[6], visibility=row[7],
            created_at=str(row[8]), updated_at=str(row[9]),
            created_by=row[10] or "", updated_by=row[11] or "",
            deleted_at=str(row[12]) if row[12] else None,
        )
