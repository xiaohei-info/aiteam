"""Employee repository — persistence for employee table."""
from typing import Optional

from ..domain.entities import Employee


class EmployeeRepo:
    """Repository for Employee entity backed by a psycopg2 cursor."""

    def __init__(self, cur):
        self._cur = cur

    def create(self, emp: Employee) -> Employee:
        self._cur.execute(
            "INSERT INTO employee (id, enterprise_id, template_id, profile_name, "
            "display_name, role_name, status, created_from, model_provider, model_name, "
            "prompt_version, config_version, avatar_url, description, capabilities_json) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (emp.id, emp.enterprise_id, emp.template_id, emp.profile_name,
             emp.display_name, emp.role_name, emp.status, emp.created_from or None,
             emp.model_provider or None, emp.model_name or None,
             emp.prompt_version, emp.config_version,
             emp.avatar_url, emp.description, emp.capabilities_json),
        )
        return emp

    def get_by_id(self, employee_id: str) -> Optional[Employee]:
        self._cur.execute(
            "SELECT id, enterprise_id, template_id, profile_name, display_name, "
            "role_name, status, created_from, model_provider, model_name, "
            "prompt_version, config_version, avatar_url, description, "
            "archive_reason, last_provisioned_at, capabilities_json, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM employee WHERE id = %s",
            (employee_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def get_by_profile_name(self, enterprise_id: str,
                             profile_name: str) -> Optional[Employee]:
        self._cur.execute(
            "SELECT id, enterprise_id, template_id, profile_name, display_name, "
            "role_name, status, created_from, model_provider, model_name, "
            "prompt_version, config_version, avatar_url, description, "
            "archive_reason, last_provisioned_at, capabilities_json, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM employee WHERE enterprise_id = %s AND profile_name = %s "
            "AND deleted_at IS NULL",
            (enterprise_id, profile_name),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_enterprise(self, enterprise_id: str) -> list[Employee]:
        self._cur.execute(
            "SELECT id, enterprise_id, template_id, profile_name, display_name, "
            "role_name, status, created_from, model_provider, model_name, "
            "prompt_version, config_version, avatar_url, description, "
            "archive_reason, last_provisioned_at, capabilities_json, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM employee WHERE enterprise_id = %s AND deleted_at IS NULL "
            "ORDER BY created_at",
            (enterprise_id,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def list_active_by_template(self, enterprise_id: str, template_id: str) -> list[Employee]:
        """Return all non-archived, non-deleted employees for an enterprise that were
        instantiated from a given template_id — used for conflict detection."""
        self._cur.execute(
            "SELECT id, enterprise_id, template_id, profile_name, display_name, "
            "role_name, status, created_from, model_provider, model_name, "
            "prompt_version, config_version, avatar_url, description, "
            "archive_reason, last_provisioned_at, capabilities_json, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM employee WHERE enterprise_id = %s AND template_id = %s "
            "AND status NOT IN ('archived') AND deleted_at IS NULL "
            "ORDER BY created_at",
            (enterprise_id, template_id),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def update_status(self, emp: Employee) -> Employee:
        self._cur.execute(
            "UPDATE employee SET display_name=%s, status=%s, model_provider=%s, model_name=%s, "
            "prompt_version=%s, config_version=%s, last_provisioned_at=%s, archive_reason=%s, "
            "capabilities_json=%s, updated_by=%s, updated_at=now() WHERE id=%s",
            (
                emp.display_name,
                emp.status,
                emp.model_provider or None,
                emp.model_name or None,
                emp.prompt_version,
                emp.config_version,
                emp.last_provisioned_at,
                emp.archive_reason,
                emp.capabilities_json,
                emp.updated_by or None,
                emp.id,
            ),
        )
        return emp

    def delete(self, employee_id: str) -> None:
        self._cur.execute(
            "UPDATE employee SET deleted_at=now() WHERE id=%s",
            (employee_id,),
        )

    @staticmethod
    def _row_to_entity(row) -> Employee:
        return Employee(
            id=row[0], enterprise_id=row[1], template_id=row[2],
            profile_name=row[3], display_name=row[4], role_name=row[5] or "",
            status=row[6], created_from=row[7] or "",
            model_provider=row[8] or "", model_name=row[9] or "",
            prompt_version=row[10], config_version=row[11],
            avatar_url=row[12], description=row[13],
            archive_reason=row[14],
            last_provisioned_at=str(row[15]) if row[15] else None,
            capabilities_json=str(row[16]) if row[16] else "{}",
            created_at=str(row[17]), updated_at=str(row[18]),
            created_by=row[19] or "", updated_by=row[20] or "",
            deleted_at=str(row[21]) if row[21] else None,
        )
