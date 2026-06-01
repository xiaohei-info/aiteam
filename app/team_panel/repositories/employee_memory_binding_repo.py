"""EmployeeMemoryBinding repository."""
from typing import Optional

from ..domain.entities import EmployeeMemoryBinding


class EmployeeMemoryBindingRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, b: EmployeeMemoryBinding) -> EmployeeMemoryBinding:
        self._cur.execute(
            "INSERT INTO employee_memory_binding (id, enterprise_id, employee_id, "
            "memory_mode, provider_code, retention_days, writeback_enabled, binding_version) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (b.id, b.enterprise_id, b.employee_id, b.memory_mode,
             b.provider_code, b.retention_days, b.writeback_enabled, b.binding_version),
        )
        return b

    def upsert(self, b: EmployeeMemoryBinding) -> EmployeeMemoryBinding:
        self._cur.execute(
            "INSERT INTO employee_memory_binding (id, enterprise_id, employee_id, "
            "memory_mode, provider_code, retention_days, writeback_enabled, binding_version) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (employee_id) DO UPDATE SET "
            "memory_mode=EXCLUDED.memory_mode, "
            "binding_version=EXCLUDED.binding_version, "
            "updated_at=now()",
            (b.id, b.enterprise_id, b.employee_id, b.memory_mode,
             b.provider_code, b.retention_days, b.writeback_enabled, b.binding_version),
        )
        return b

    def get_by_employee(self, employee_id: str) -> Optional[EmployeeMemoryBinding]:
        self._cur.execute(
            "SELECT id, enterprise_id, employee_id, memory_mode, provider_code, "
            "retention_days, writeback_enabled, binding_version, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM employee_memory_binding WHERE employee_id = %s",
            (employee_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def get_by_id(self, binding_id: str) -> Optional[EmployeeMemoryBinding]:
        self._cur.execute(
            "SELECT id, enterprise_id, employee_id, memory_mode, provider_code, "
            "retention_days, writeback_enabled, binding_version, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM employee_memory_binding WHERE id = %s",
            (binding_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def update(self, b: EmployeeMemoryBinding) -> EmployeeMemoryBinding:
        self._cur.execute(
            "UPDATE employee_memory_binding SET memory_mode=%s, binding_version=%s, "
            "updated_at=now() WHERE employee_id=%s",
            (b.memory_mode, b.binding_version, b.employee_id),
        )
        return b

    def delete(self, employee_id: str) -> None:
        self._cur.execute(
            "UPDATE employee_memory_binding SET deleted_at=now() WHERE employee_id=%s",
            (employee_id,),
        )

    @staticmethod
    def _row_to_entity(row) -> EmployeeMemoryBinding:
        return EmployeeMemoryBinding(
            id=row[0], enterprise_id=row[1], employee_id=row[2],
            memory_mode=row[3], provider_code=row[4],
            retention_days=row[5], writeback_enabled=row[6],
            binding_version=row[7],
            created_at=str(row[8]), updated_at=str(row[9]),
            created_by=row[10] or "", updated_by=row[11] or "",
            deleted_at=str(row[12]) if row[12] else None,
        )
