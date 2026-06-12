"""CollaborationTemplate repository — enterprise orchestration prompt templates."""
from typing import List, Optional

from ..domain.entities import CollaborationTemplate


class CollaborationTemplateRepo:
    def __init__(self, cur):
        self._cur = cur

    _SELECT = (
        "SELECT id, enterprise_id, name, planner_prompt, subtask_prompt, "
        "aggregate_prompt, is_default, enabled, created_at, updated_at, created_by "
        "FROM collaboration_template"
    )

    def create(self, t: CollaborationTemplate) -> CollaborationTemplate:
        self._cur.execute(
            "INSERT INTO collaboration_template (id, enterprise_id, name, "
            "planner_prompt, subtask_prompt, aggregate_prompt, is_default, enabled, created_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (t.id, t.enterprise_id, t.name, t.planner_prompt, t.subtask_prompt,
             t.aggregate_prompt, t.is_default, t.enabled, t.created_by),
        )
        return t

    def get_by_id(self, template_id: str) -> Optional[CollaborationTemplate]:
        self._cur.execute(self._SELECT + " WHERE id = %s", (template_id,))
        row = self._cur.fetchone()
        return self._row(row) if row else None

    def list_by_enterprise(self, enterprise_id: str) -> List[CollaborationTemplate]:
        self._cur.execute(
            self._SELECT + " WHERE enterprise_id = %s ORDER BY created_at",
            (enterprise_id,),
        )
        return [self._row(r) for r in self._cur.fetchall()]

    def get_default(self, enterprise_id: str) -> Optional[CollaborationTemplate]:
        self._cur.execute(
            self._SELECT + " WHERE enterprise_id = %s AND enabled = TRUE "
            "ORDER BY is_default DESC, created_at LIMIT 1",
            (enterprise_id,),
        )
        row = self._cur.fetchone()
        return self._row(row) if row else None

    def update(self, t: CollaborationTemplate) -> CollaborationTemplate:
        self._cur.execute(
            "UPDATE collaboration_template SET name=%s, planner_prompt=%s, "
            "subtask_prompt=%s, aggregate_prompt=%s, is_default=%s, enabled=%s, "
            "updated_at=now() WHERE id=%s",
            (t.name, t.planner_prompt, t.subtask_prompt, t.aggregate_prompt,
             t.is_default, t.enabled, t.id),
        )
        return t

    def delete(self, template_id: str) -> None:
        self._cur.execute(
            "DELETE FROM collaboration_template WHERE id=%s", (template_id,)
        )

    @staticmethod
    def _row(row) -> CollaborationTemplate:
        return CollaborationTemplate(
            id=row[0], enterprise_id=row[1], name=row[2] or "",
            planner_prompt=row[3] or "", subtask_prompt=row[4] or "",
            aggregate_prompt=row[5] or "", is_default=bool(row[6]),
            enabled=bool(row[7]), created_at=str(row[8]), updated_at=str(row[9]),
            created_by=row[10] or "",
        )
