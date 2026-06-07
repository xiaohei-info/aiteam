"""EnterpriseConnector repository."""
import json
from typing import Optional

from ..domain.entities import EnterpriseConnector


_CONNECTOR_SECRET_MARKERS = ("secret", "token", "password", "key", "credential")


def _is_secret_bearing_connector_key(key: object) -> bool:
    key_text = str(key).lower()
    return any(marker in key_text for marker in _CONNECTOR_SECRET_MARKERS)


def _sanitize_connector_config_value(value: object, *, parent_key: object | None = None) -> object:
    if parent_key is not None and _is_secret_bearing_connector_key(parent_key):
        return "****" if value not in (None, "") else ""
    if isinstance(value, dict):
        return {
            str(key): _sanitize_connector_config_value(child_value, parent_key=key)
            for key, child_value in value.items()
        }
    if isinstance(value, list):
        return [
            _sanitize_connector_config_value(item, parent_key=parent_key)
            for item in value
        ]
    return value


def _sanitize_connector_config_json(config_json: object) -> str:
    if isinstance(config_json, dict):
        payload = config_json
    elif isinstance(config_json, str) and config_json.strip():
        try:
            payload = json.loads(config_json)
        except ValueError:
            return json.dumps({}, ensure_ascii=False)
    else:
        payload = {}
    if not isinstance(payload, dict):
        return json.dumps({}, ensure_ascii=False)
    sanitized = {
        str(key): _sanitize_connector_config_value(value, parent_key=key)
        for key, value in payload.items()
    }
    return json.dumps(sanitized, ensure_ascii=False)


class EnterpriseConnectorRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, c: EnterpriseConnector) -> EnterpriseConnector:
        c.config_json = _sanitize_connector_config_json(c.config_json)
        self._cur.execute(
            "INSERT INTO enterprise_connector (id, enterprise_id, definition_id, name, provider_code, "
            "connector_type, credential_ref, credential_mask, credential_state, rotation_version, status, config_json, scopes_json, last_test_result_json, updated_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s)",
            (c.id, c.enterprise_id, c.definition_id, c.name, c.provider_code,
             c.connector_type, c.credential_ref, c.credential_mask, c.credential_state, c.rotation_version,
             c.status, c.config_json, c.scopes_json, c.last_test_result_json, c.updated_by or None),
        )
        return c

    def get_by_id(self, connector_id: str) -> Optional[EnterpriseConnector]:
        self._cur.execute(
            "SELECT id, enterprise_id, definition_id, name, provider_code, connector_type, "
            "credential_ref, credential_mask, credential_state, rotation_version, status, config_json, scopes_json, last_test_result_json, "
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
            "SELECT id, enterprise_id, definition_id, name, provider_code, connector_type, "
            "credential_ref, credential_mask, credential_state, rotation_version, status, config_json, scopes_json, last_test_result_json, "
            "last_validated_at, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM enterprise_connector WHERE enterprise_id = %s AND deleted_at IS NULL "
            "ORDER BY name",
            (enterprise_id,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def update(self, c: EnterpriseConnector) -> EnterpriseConnector:
        c.config_json = _sanitize_connector_config_json(c.config_json)
        self._cur.execute(
            "UPDATE enterprise_connector SET definition_id=%s, name=%s, provider_code=%s, connector_type=%s, credential_ref=%s, credential_mask=%s, credential_state=%s, status=%s, rotation_version=%s, config_json=%s, scopes_json=%s::jsonb, last_test_result_json=%s::jsonb, updated_by=%s, updated_at=now() WHERE id=%s",
            (c.definition_id, c.name, c.provider_code, c.connector_type, c.credential_ref, c.credential_mask, c.credential_state, c.status, c.rotation_version, c.config_json, c.scopes_json, c.last_test_result_json, c.updated_by or None, c.id),
        )
        return c

    def delete(self, connector_id: str) -> None:
        self._cur.execute(
            "UPDATE enterprise_connector SET deleted_at=now() WHERE id=%s",
            (connector_id,),
        )

    @staticmethod
    def _row_to_entity(row) -> EnterpriseConnector:
        config_json = json.dumps(row[11], ensure_ascii=False) if isinstance(row[11], (dict, list)) else (str(row[11]) if row[11] else "{}")
        scopes_json = json.dumps(row[12], ensure_ascii=False) if isinstance(row[12], (dict, list)) else (str(row[12]) if row[12] else "[]")
        last_test_result_json = json.dumps(row[13], ensure_ascii=False) if isinstance(row[13], (dict, list)) else (str(row[13]) if row[13] else '{"result": "never_tested"}')
        return EnterpriseConnector(
            id=row[0], enterprise_id=row[1], definition_id=row[2], name=row[3],
            provider_code=row[4], connector_type=row[5],
            credential_ref=row[6], credential_mask=row[7] or "未配置", credential_state=row[8] or "missing", rotation_version=row[9],
            status=row[10],
            config_json=config_json,
            scopes_json=scopes_json,
            last_test_result_json=last_test_result_json,
            last_validated_at=str(row[14]) if row[14] else None,
            created_at=str(row[15]), updated_at=str(row[16]),
            created_by=row[17] or "", updated_by=row[18] or "",
            deleted_at=str(row[19]) if row[19] else None,
        )
