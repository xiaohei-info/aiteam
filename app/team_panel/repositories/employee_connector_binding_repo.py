"""EmployeeConnectorBinding repository."""
from typing import Optional

from ..domain.entities import EmployeeConnectorBinding


class EmployeeConnectorBindingRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, b: EmployeeConnectorBinding) -> EmployeeConnectorBinding:
        self._cur.execute(
            "INSERT INTO employee_connector_binding (id, enterprise_id, employee_id, "
            "connector_id, enabled, access_mode, binding_version) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (b.id, b.enterprise_id, b.employee_id, b.connector_id,
             b.enabled, b.access_mode, b.binding_version),
        )
        return b

    def get_by_id(self, binding_id: str) -> Optional[EmployeeConnectorBinding]:
        self._cur.execute(
            "SELECT id, enterprise_id, employee_id, connector_id, enabled, "
            "access_mode, binding_version, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM employee_connector_binding WHERE id = %s",
            (binding_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_employee(self, employee_id: str) -> list[EmployeeConnectorBinding]:
        self._cur.execute(
            "SELECT id, enterprise_id, employee_id, connector_id, enabled, "
            "access_mode, binding_version, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM employee_connector_binding WHERE employee_id = %s AND deleted_at IS NULL "
            "ORDER BY connector_id",
            (employee_id,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def list_by_connector(self, connector_id: str) -> list[EmployeeConnectorBinding]:
        self._cur.execute(
            "SELECT id, enterprise_id, employee_id, connector_id, enabled, "
            "access_mode, binding_version, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM employee_connector_binding WHERE connector_id = %s AND deleted_at IS NULL "
            "ORDER BY employee_id",
            (connector_id,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def update(self, b: EmployeeConnectorBinding) -> EmployeeConnectorBinding:
        self._cur.execute(
            "UPDATE employee_connector_binding SET enabled=%s, binding_version=%s, "
            "updated_at=now() WHERE id=%s",
            (b.enabled, b.binding_version, b.id),
        )
        return b

    def delete(self, binding_id: str) -> None:
        self._cur.execute(
            "UPDATE employee_connector_binding SET deleted_at=now() WHERE id=%s",
            (binding_id,),
        )

    @staticmethod
    def _row_to_entity(row) -> EmployeeConnectorBinding:
        return EmployeeConnectorBinding(
            id=row[0], enterprise_id=row[1], employee_id=row[2],
            connector_id=row[3], enabled=row[4],
            access_mode=row[5], binding_version=row[6],
            created_at=str(row[7]), updated_at=str(row[8]),
            created_by=row[9] or "", updated_by=row[10] or "",
            deleted_at=str(row[11]) if row[11] else None,
        )
