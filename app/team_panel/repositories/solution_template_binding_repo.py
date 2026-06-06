"""SolutionTemplateBinding repository."""
from ..domain.entities import SolutionTemplateBinding


class SolutionTemplateBindingRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, binding: SolutionTemplateBinding) -> SolutionTemplateBinding:
        self._cur.execute(
            "INSERT INTO solution_template_binding (id, solution_id, template_id, sequence_no, enabled) "
            "VALUES (%s, %s, %s, %s, %s)",
            (binding.id, binding.solution_id, binding.template_id, binding.sequence_no, binding.enabled),
        )
        return binding

    def list_by_solution(self, solution_id: str) -> list[SolutionTemplateBinding]:
        self._cur.execute(
            "SELECT id, solution_id, template_id, sequence_no, enabled, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM solution_template_binding WHERE solution_id = %s AND deleted_at IS NULL "
            "ORDER BY sequence_no, created_at",
            (solution_id,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(row) for row in rows]

    def delete_by_solution(self, solution_id: str) -> None:
        self._cur.execute(
            "UPDATE solution_template_binding SET deleted_at=now(), updated_at=now() WHERE solution_id = %s AND deleted_at IS NULL",
            (solution_id,),
        )

    @staticmethod
    def _row_to_entity(row) -> SolutionTemplateBinding:
        return SolutionTemplateBinding(
            id=row[0],
            solution_id=row[1],
            template_id=row[2],
            sequence_no=row[3],
            enabled=bool(row[4]),
            created_at=str(row[5]),
            updated_at=str(row[6]),
            created_by=row[7] or "",
            updated_by=row[8] or "",
            deleted_at=str(row[9]) if row[9] else None,
        )
