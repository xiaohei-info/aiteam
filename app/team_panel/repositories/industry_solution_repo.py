"""IndustrySolution repository."""
import json
from typing import Optional

from ..domain.entities import IndustrySolution


class IndustrySolutionRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, solution: IndustrySolution) -> IndustrySolution:
        self._cur.execute(
            "INSERT INTO industry_solution (id, name, status, tags_json, default_kb_blueprint_json, "
            "default_skill_bundle_json, default_collaboration_template_ref) "
            "VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s)",
            (
                solution.id,
                solution.name,
                solution.status,
                solution.tags_json,
                solution.default_kb_blueprint_json,
                solution.default_skill_bundle_json,
                solution.default_collaboration_template_ref,
            ),
        )
        return solution

    def get_by_id(self, solution_id: str) -> Optional[IndustrySolution]:
        self._cur.execute(
            "SELECT id, name, status, tags_json, default_kb_blueprint_json, default_skill_bundle_json, "
            "default_collaboration_template_ref, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM industry_solution WHERE id = %s",
            (solution_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    @staticmethod
    def _row_to_entity(row) -> IndustrySolution:
        return IndustrySolution(
            id=row[0],
            name=row[1] or "",
            status=row[2],
            tags_json=json.dumps(row[3]) if row[3] is not None else "[]",
            default_kb_blueprint_json=json.dumps(row[4]) if row[4] is not None else "{}",
            default_skill_bundle_json=json.dumps(row[5]) if row[5] is not None else "{}",
            default_collaboration_template_ref=row[6],
            created_at=str(row[7]),
            updated_at=str(row[8]),
            created_by=row[9] or "",
            updated_by=row[10] or "",
            deleted_at=str(row[11]) if row[11] else None,
        )
