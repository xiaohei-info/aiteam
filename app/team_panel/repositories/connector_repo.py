"""EnterpriseConnector repository."""
from typing import Optional

from ..domain.entities import EnterpriseConnector


class EnterpriseConnectorRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, c: EnterpriseConnector) -> EnterpriseConnector:
        self._cur.execute(
            "INSERT INTO enterprise_connector (id, enterprise_id, name, provider_code, "
            "connector_type, credential_ref, rotation_version, status, config_json) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (c.id, c.enterprise_id, c.name, c.provider_code,
             c.connector_type, c.credential_ref, c.rotation_version,
             c.status, c.config_json),
        )
        return c

    def get_by_id(self, connector_id: str) -> Optional[EnterpriseConnector]:
        self._cur.execute(
            "SELECT id, enterprise_id, name, provider_code, connector_type, "
            "credential_ref, rotation_version, status, config_json, "
            "last_validated_at, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM enterprise_connector WHERE id = %s",
            (connector_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_enterprise(self, enterprise_id: str) -> list[EnterpriseConnector]:
        self._cur.execute(
            "SELECT id, enterprise_id, name, provider_code, connector_type, "
            "credential_ref, rotation_version, status, config_json, "
            "last_validated_at, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM enterprise_connector WHERE enterprise_id = %s AND deleted_at IS NULL "
            "ORDER BY name",
            (enterprise_id,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def update(self, c: EnterpriseConnector) -> EnterpriseConnector:
        self._cur.execute(
            "UPDATE enterprise_connector SET status=%s, rotation_version=%s, "
            "updated_at=now() WHERE id=%s",
            (c.status, c.rotation_version, c.id),
        )
        return c

    def delete(self, connector_id: str) -> None:
        self._cur.execute(
            "UPDATE enterprise_connector SET deleted_at=now() WHERE id=%s",
            (connector_id,),
        )

    @staticmethod
    def _row_to_entity(row) -> EnterpriseConnector:
        return EnterpriseConnector(
            id=row[0], enterprise_id=row[1], name=row[2],
            provider_code=row[3], connector_type=row[4],
            credential_ref=row[5], rotation_version=row[6],
            status=row[7],
            config_json=str(row[8]) if row[8] else "{}",
            last_validated_at=str(row[9]) if row[9] else None,
            created_at=str(row[10]), updated_at=str(row[11]),
            created_by=row[12] or "", updated_by=row[13] or "",
            deleted_at=str(row[14]) if row[14] else None,
        )
