"""AuditEvent repository — persistence for audit_event table."""

import json
from typing import Optional

from ..domain.entities import AuditEvent


class AuditEventRepo:
    """Repository for AuditEvent entity backed by a psycopg cursor."""

    def __init__(self, cur):
        self._cur = cur

    def create(self, event: AuditEvent) -> AuditEvent:
        self._cur.execute(
            "INSERT INTO audit_event (id, enterprise_id, actor_type, actor_id, "
            "event_type, target_type, target_id, request_id, payload_json, "
            "created_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (event.id, event.enterprise_id, event.actor_type, event.actor_id,
             event.event_type, event.target_type, event.target_id,
             event.request_id, event.payload_json,
             event.created_by or None),
        )
        return event

    def get_by_id(self, event_id: str) -> Optional[AuditEvent]:
        self._cur.execute(
            "SELECT id, enterprise_id, actor_type, actor_id, event_type, "
            "target_type, target_id, request_id, payload_json, "
            "created_at, created_by "
            "FROM audit_event WHERE id = %s",
            (event_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_enterprise(self, enterprise_id: str, *,
                           limit: int = 100) -> list[AuditEvent]:
        self._cur.execute(
            "SELECT id, enterprise_id, actor_type, actor_id, event_type, "
            "target_type, target_id, request_id, payload_json, "
            "created_at, created_by "
            "FROM audit_event WHERE enterprise_id = %s "
            "ORDER BY created_at DESC LIMIT %s",
            (enterprise_id, limit),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def list_by_target(self, target_type: str, target_id: str, *,
                       limit: int = 100) -> list[AuditEvent]:
        self._cur.execute(
            "SELECT id, enterprise_id, actor_type, actor_id, event_type, "
            "target_type, target_id, request_id, payload_json, "
            "created_at, created_by "
            "FROM audit_event WHERE target_type = %s AND target_id = %s "
            "ORDER BY created_at DESC LIMIT %s",
            (target_type, target_id, limit),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    @staticmethod
    def _row_to_entity(row) -> AuditEvent:
        return AuditEvent(
            id=row[0], enterprise_id=row[1],
            actor_type=row[2], actor_id=row[3],
            event_type=row[4],
            target_type=row[5], target_id=row[6],
            request_id=row[7],
            payload_json=json.dumps(row[8]) if row[8] else "{}",
            created_at=str(row[9]),
            created_by=row[10] or "",
        )
