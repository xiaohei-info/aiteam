"""ConnectorDefinition repository."""
import json
from typing import Optional

from ..domain.entities import ConnectorDefinition


class ConnectorDefinitionRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, definition: ConnectorDefinition) -> ConnectorDefinition:
        self._cur.execute(
            "INSERT INTO connector_definition (id, provider_code, connector_type, display_name, "
            "auth_scheme, config_schema_json, status) "
            "VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s)",
            (
                definition.id,
                definition.provider_code,
                definition.connector_type,
                definition.display_name,
                definition.auth_scheme,
                definition.config_schema_json,
                definition.status,
            ),
        )
        return definition

    def get_by_id(self, definition_id: str) -> Optional[ConnectorDefinition]:
        self._cur.execute(
            "SELECT id, provider_code, connector_type, display_name, auth_scheme, config_schema_json, "
            "status, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM connector_definition WHERE id = %s",
            (definition_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_active(self) -> list[ConnectorDefinition]:
        self._cur.execute(
            "SELECT id, provider_code, connector_type, display_name, auth_scheme, config_schema_json, "
            "status, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM connector_definition WHERE deleted_at IS NULL AND status = 'active' "
            "ORDER BY provider_code, display_name, id"
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(row) for row in rows]

    @staticmethod
    def _row_to_entity(row) -> ConnectorDefinition:
        return ConnectorDefinition(
            id=row[0],
            provider_code=row[1],
            connector_type=row[2],
            display_name=row[3] or "",
            auth_scheme=row[4] or "opaque_ref",
            config_schema_json=json.dumps(row[5], ensure_ascii=False) if isinstance(row[5], dict) else (str(row[5]) if row[5] else "{}"),
            status=row[6] or "active",
            created_at=str(row[7]),
            updated_at=str(row[8]),
            created_by=row[9] or "",
            updated_by=row[10] or "",
            deleted_at=str(row[11]) if row[11] else None,
        )
