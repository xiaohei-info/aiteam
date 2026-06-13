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
            "default_skill_bundle_json, default_collaboration_template_ref, publish_scope_json, "
            "planner_prompt, subtask_prompt, aggregate_prompt) "
            "VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s::jsonb, %s, %s, %s)",
            (
                solution.id,
                solution.name,
                solution.status,
                solution.tags_json,
                solution.default_kb_blueprint_json,
                solution.default_skill_bundle_json,
                solution.default_collaboration_template_ref,
                solution.publish_scope_json,
                solution.planner_prompt or "",
                solution.subtask_prompt or "",
                solution.aggregate_prompt or "",
            ),
        )
        return solution

    def get_by_id(self, solution_id: str) -> Optional[IndustrySolution]:
        self._cur.execute(
            "SELECT id, name, status, tags_json, default_kb_blueprint_json, default_skill_bundle_json, "
            "default_collaboration_template_ref, created_at, updated_at, created_by, updated_by, deleted_at, "
            "publish_scope_json, planner_prompt, subtask_prompt, aggregate_prompt "
            "FROM industry_solution WHERE id = %s",
            (solution_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_all(self) -> list[IndustrySolution]:
        self._cur.execute(
            "SELECT id, name, status, tags_json, default_kb_blueprint_json, default_skill_bundle_json, "
            "default_collaboration_template_ref, created_at, updated_at, created_by, updated_by, deleted_at, "
            "publish_scope_json, planner_prompt, subtask_prompt, aggregate_prompt "
            "FROM industry_solution ORDER BY created_at"
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(row) for row in rows]

    def update(self, solution: IndustrySolution) -> IndustrySolution:
        self._cur.execute(
            "UPDATE industry_solution SET name=%s, status=%s, tags_json=%s::jsonb, default_kb_blueprint_json=%s::jsonb, "
            "default_skill_bundle_json=%s::jsonb, default_collaboration_template_ref=%s, publish_scope_json=%s::jsonb, "
            "planner_prompt=%s, subtask_prompt=%s, aggregate_prompt=%s, "
            "updated_at=now(), updated_by=%s "
            "WHERE id=%s",
            (
                solution.name,
                solution.status,
                solution.tags_json,
                solution.default_kb_blueprint_json,
                solution.default_skill_bundle_json,
                solution.default_collaboration_template_ref,
                solution.publish_scope_json,
                solution.planner_prompt or "",
                solution.subtask_prompt or "",
                solution.aggregate_prompt or "",
                solution.updated_by or None,
                solution.id,
            ),
        )
        return solution

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
            publish_scope_json=json.dumps(row[12]) if len(row) > 12 and row[12] else '{"mode":"all"}',
            planner_prompt=row[13] if len(row) > 13 and row[13] else "",
            subtask_prompt=row[14] if len(row) > 14 and row[14] else "",
            aggregate_prompt=row[15] if len(row) > 15 and row[15] else "",
        )
