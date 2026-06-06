"""AgentTemplate repository."""
import json
from typing import Optional

from ..domain.entities import AgentTemplate


class AgentTemplateRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, t: AgentTemplate) -> AgentTemplate:
        self._cur.execute(
            "INSERT INTO agent_template (id, name, category_code, role_name, status, "
            "prompt_pack_json, default_model_json, default_binding_json, "
            "version_no, source_type, owner_enterprise_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (t.id, t.name, t.category_code, t.role_name, t.status,
             t.prompt_pack_json, t.default_model_json, t.default_binding_json,
             t.version_no, t.source_type, t.owner_enterprise_id),
        )
        return t

    def get_by_id(self, template_id: str) -> Optional[AgentTemplate]:
        self._cur.execute(
            "SELECT id, name, category_code, role_name, status, "
            "prompt_pack_json, default_model_json, default_binding_json, "
            "version_no, source_type, owner_enterprise_id, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM agent_template WHERE id = %s",
            (template_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_all(self) -> list[AgentTemplate]:
        self._cur.execute(
            "SELECT id, name, category_code, role_name, status, "
            "prompt_pack_json, default_model_json, default_binding_json, "
            "version_no, source_type, owner_enterprise_id, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM agent_template ORDER BY created_at"
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def list_by_status(self, status: str) -> list[AgentTemplate]:
        self._cur.execute(
            "SELECT id, name, category_code, role_name, status, "
            "prompt_pack_json, default_model_json, default_binding_json, "
            "version_no, source_type, owner_enterprise_id, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM agent_template WHERE status = %s AND deleted_at IS NULL "
            "ORDER BY created_at",
            (status,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def update(self, t: AgentTemplate) -> AgentTemplate:
        self._cur.execute(
            "UPDATE agent_template SET name=%s, category_code=%s, role_name=%s, status=%s, "
            "prompt_pack_json=%s::jsonb, default_model_json=%s::jsonb, default_binding_json=%s::jsonb, "
            "version_no=%s, updated_at=now(), updated_by=%s WHERE id=%s",
            (
                t.name,
                t.category_code,
                t.role_name,
                t.status,
                t.prompt_pack_json,
                t.default_model_json,
                t.default_binding_json,
                t.version_no,
                t.updated_by or None,
                t.id,
            ),
        )
        return t

    def delete(self, template_id: str) -> None:
        self._cur.execute(
            "UPDATE agent_template SET deleted_at=now() WHERE id=%s",
            (template_id,),
        )

    @staticmethod
    def _row_to_entity(row) -> AgentTemplate:
        return AgentTemplate(
            id=row[0], name=row[1], category_code=row[2] or "",
            role_name=row[3] or "", status=row[4],
            prompt_pack_json=json.dumps(row[5]) if row[5] else "{}",
            default_model_json=json.dumps(row[6]) if row[6] else "{}",
            default_binding_json=json.dumps(row[7]) if row[7] else "{}",
            version_no=row[8], source_type=row[9],
            owner_enterprise_id=row[10],
            created_at=str(row[11]), updated_at=str(row[12]),
            created_by=row[13] or "", updated_by=row[14] or "",
            deleted_at=str(row[15]) if row[15] else None,
        )
