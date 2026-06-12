"""AgentTemplate repository."""
import json
from typing import Optional

from ..domain.entities import AgentTemplate

# Allowed sort columns — maps external sort key → DB column
_SORT_COLUMN_MAP = {
    "created_at": "created_at",
    "name": "name",
    "popularity": "recruit_count",
    "recruit_count": "recruit_count",
}
_DEFAULT_SORT = "created_at"
_DEFAULT_SORT_ORDER = "desc"


class AgentTemplateRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, t: AgentTemplate) -> AgentTemplate:
        self._cur.execute(
            "INSERT INTO agent_template (id, name, category_code, role_name, status, "
            "prompt_pack_json, default_model_json, default_binding_json, "
            "version_no, source_type, owner_enterprise_id, publish_scope_json) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)",
            (t.id, t.name, t.category_code, t.role_name, t.status,
             t.prompt_pack_json, t.default_model_json, t.default_binding_json,
             t.version_no, t.source_type, t.owner_enterprise_id, t.publish_scope_json),
        )
        return t

    def get_by_id(self, template_id: str) -> Optional[AgentTemplate]:
        self._cur.execute(
            "SELECT id, name, category_code, role_name, status, "
            "prompt_pack_json, default_model_json, default_binding_json, "
            "version_no, source_type, owner_enterprise_id, "
            "created_at, updated_at, created_by, updated_by, deleted_at, publish_scope_json "
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
            "created_at, updated_at, created_by, updated_by, deleted_at, publish_scope_json "
            "FROM agent_template ORDER BY created_at"
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def list_by_status(self, status: str) -> list[AgentTemplate]:
        self._cur.execute(
            "SELECT id, name, category_code, role_name, status, "
            "prompt_pack_json, default_model_json, default_binding_json, "
            "version_no, source_type, owner_enterprise_id, "
            "created_at, updated_at, created_by, updated_by, deleted_at, publish_scope_json "
            "FROM agent_template WHERE status = %s AND deleted_at IS NULL "
            "ORDER BY created_at",
            (status,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def list_filtered(
        self,
        *,
        status: str | None = None,
        category_code: str | None = None,
        keyword: str | None = None,
        tag: str | None = None,
        sort_by: str = _DEFAULT_SORT,
        sort_order: str = _DEFAULT_SORT_ORDER,
        limit: int = 20,
        offset: int = 0,
        visible_to_enterprise_id: str | None = None,
    ) -> tuple[list[AgentTemplate], int]:
        """Return filtered + paginated templates.

        Returns (items, total_count).

        When *visible_to_enterprise_id* is given, only templates whose
        publish_scope_json is mode=all, or mode=selected including that
        enterprise id, are returned. None disables the visibility filter.
        """
        db_sort = _SORT_COLUMN_MAP.get(sort_by, _DEFAULT_SORT)
        db_order = "DESC" if sort_order.lower() == "desc" else "ASC"
        order_by_expr = {
            "created_at": "t.created_at",
            "name": "LOWER(t.name)",
            "recruit_count": "COALESCE(rc.recruit_count, 0)",
        }[db_sort]

        conditions = ["t.deleted_at IS NULL"]
        params: list = []

        if status:
            conditions.append("t.status = %s")
            params.append(status)
        if category_code:
            conditions.append("t.category_code = %s")
            params.append(category_code)
        if keyword:
            kw = f"%{keyword}%"
            conditions.append(
                "(t.name ILIKE %s OR t.role_name ILIKE %s "
                "OR t.category_code ILIKE %s "
                "OR t.prompt_pack_json::text ILIKE %s "
                "OR t.default_binding_json::text ILIKE %s)"
            )
            params.extend([kw, kw, kw, kw, kw])
        if tag:
            conditions.append("(t.category_code = %s OR COALESCE(t.prompt_pack_json->'tags', '[]'::jsonb) ? %s)")
            params.extend([tag, tag])
        if visible_to_enterprise_id is not None:
            # Visible when scope is not "selected", or selected list contains this enterprise.
            conditions.append(
                "(COALESCE(t.publish_scope_json->>'mode', 'all') <> 'selected' "
                "OR COALESCE(t.publish_scope_json->'enterprise_ids', '[]'::jsonb) ? %s)"
            )
            params.append(str(visible_to_enterprise_id))

        where_clause = " AND ".join(conditions)

        # Count total
        self._cur.execute(
            f"SELECT COUNT(*) FROM agent_template t WHERE {where_clause}",
            params,
        )
        total = self._cur.fetchone()[0]

        # Fetch page
        query_sql = (
            f"SELECT t.id, t.name, t.category_code, t.role_name, t.status, "
            f"t.prompt_pack_json, t.default_model_json, t.default_binding_json, "
            f"t.version_no, t.source_type, t.owner_enterprise_id, "
            f"t.created_at, t.updated_at, t.created_by, t.updated_by, t.deleted_at, t.publish_scope_json "
            f"FROM agent_template t "
            f"LEFT JOIN ("
            f"  SELECT template_id, COUNT(*)::int AS recruit_count "
            f"  FROM recruitment_order "
            f"  WHERE deleted_at IS NULL "
            f"  GROUP BY template_id"
            f") rc ON rc.template_id = t.id "
            f"WHERE {where_clause} "
            f"ORDER BY {order_by_expr} {db_order}, t.created_at DESC "
            f"LIMIT %s OFFSET %s"
        )
        self._cur.execute(query_sql, params + [limit, offset])
        rows = self._cur.fetchall()
        items = [self._row_to_entity(r) for r in rows]

        return items, total

    def update(self, t: AgentTemplate) -> AgentTemplate:
        self._cur.execute(
            "UPDATE agent_template SET name=%s, category_code=%s, role_name=%s, status=%s, "
            "prompt_pack_json=%s::jsonb, default_model_json=%s::jsonb, default_binding_json=%s::jsonb, "
            "version_no=%s, publish_scope_json=%s::jsonb, updated_at=now(), updated_by=%s WHERE id=%s",
            (
                t.name,
                t.category_code,
                t.role_name,
                t.status,
                t.prompt_pack_json,
                t.default_model_json,
                t.default_binding_json,
                t.version_no,
                t.publish_scope_json,
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
            publish_scope_json=json.dumps(row[16]) if row[16] else '{"mode":"all"}',
        )
