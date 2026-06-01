"""EmployeePrompt repository."""
from typing import Optional

from ..domain.entities import EmployeePrompt


class EmployeePromptRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, p: EmployeePrompt) -> EmployeePrompt:
        self._cur.execute(
            "INSERT INTO employee_prompt (employee_id, system_prompt, behavior_rules_json, "
            "opening_message, version_no, source_template_version) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (p.employee_id, p.system_prompt, p.behavior_rules_json,
             p.opening_message, p.version_no, p.source_template_version),
        )
        return p

    def upsert(self, p: EmployeePrompt) -> EmployeePrompt:
        self._cur.execute(
            "INSERT INTO employee_prompt (employee_id, system_prompt, behavior_rules_json, "
            "opening_message, version_no, source_template_version) "
            "VALUES (%s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (employee_id) DO UPDATE SET "
            "system_prompt=EXCLUDED.system_prompt, "
            "behavior_rules_json=EXCLUDED.behavior_rules_json, "
            "opening_message=EXCLUDED.opening_message, "
            "version_no=EXCLUDED.version_no, "
            "source_template_version=EXCLUDED.source_template_version, "
            "updated_at=now()",
            (p.employee_id, p.system_prompt, p.behavior_rules_json,
             p.opening_message, p.version_no, p.source_template_version),
        )
        return p

    def get_by_employee(self, employee_id: str) -> Optional[EmployeePrompt]:
        self._cur.execute(
            "SELECT employee_id, system_prompt, behavior_rules_json, "
            "opening_message, version_no, source_template_version, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM employee_prompt WHERE employee_id = %s",
            (employee_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def get_by_id(self, employee_id: str) -> Optional[EmployeePrompt]:
        return self.get_by_employee(employee_id)

    def update(self, p: EmployeePrompt) -> EmployeePrompt:
        return self.upsert(p)

    def delete(self, employee_id: str) -> None:
        self._cur.execute(
            "UPDATE employee_prompt SET deleted_at=now() WHERE employee_id=%s",
            (employee_id,),
        )

    @staticmethod
    def _row_to_entity(row) -> EmployeePrompt:
        return EmployeePrompt(
            employee_id=row[0], system_prompt=row[1],
            behavior_rules_json=str(row[2]) if row[2] else "{}",
            opening_message=row[3],
            version_no=row[4],
            source_template_version=row[5],
            created_at=str(row[6]), updated_at=str(row[7]),
            created_by=row[8] or "", updated_by=row[9] or "",
            deleted_at=str(row[10]) if row[10] else None,
        )
