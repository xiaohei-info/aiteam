"""RuntimeBinding repository — persistence for runtime_binding table."""

from typing import Optional

from ..domain.entities import RuntimeBinding


class RuntimeBindingRepo:
    """Repository for RuntimeBinding entity backed by a psycopg cursor."""

    def __init__(self, cur):
        self._cur = cur

    def create(self, binding: RuntimeBinding) -> RuntimeBinding:
        self._cur.execute(
            "INSERT INTO runtime_binding (id, enterprise_id, owner_type, owner_id, "
            "profile_name, runtime_kind, runtime_session_id, runtime_task_id, "
            "runtime_job_id, sync_status, event_cursor, runtime_source_cursor, "
            "last_synced_at, last_error, created_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (binding.id, binding.enterprise_id, binding.owner_type,
             binding.owner_id, binding.profile_name, binding.runtime_kind,
             binding.runtime_session_id, binding.runtime_task_id,
             binding.runtime_job_id, binding.sync_status,
             binding.event_cursor, binding.runtime_source_cursor,
             binding.last_synced_at or None, binding.last_error or None,
             binding.created_by or None),
        )
        return binding

    def get_by_id(self, binding_id: str) -> Optional[RuntimeBinding]:
        self._cur.execute(
            "SELECT id, enterprise_id, owner_type, owner_id, profile_name, "
            "runtime_kind, runtime_session_id, runtime_task_id, runtime_job_id, "
            "sync_status, event_cursor, runtime_source_cursor, "
            "last_synced_at, last_error, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM runtime_binding WHERE id = %s",
            (binding_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def get_by_owner(self, owner_type: str, owner_id: str) -> Optional[RuntimeBinding]:
        self._cur.execute(
            "SELECT id, enterprise_id, owner_type, owner_id, profile_name, "
            "runtime_kind, runtime_session_id, runtime_task_id, runtime_job_id, "
            "sync_status, event_cursor, runtime_source_cursor, "
            "last_synced_at, last_error, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM runtime_binding WHERE owner_type = %s AND owner_id = %s "
            "AND deleted_at IS NULL",
            (owner_type, owner_id),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_enterprise(self, enterprise_id: str) -> list[RuntimeBinding]:
        self._cur.execute(
            "SELECT id, enterprise_id, owner_type, owner_id, profile_name, "
            "runtime_kind, runtime_session_id, runtime_task_id, runtime_job_id, "
            "sync_status, event_cursor, runtime_source_cursor, "
            "last_synced_at, last_error, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM runtime_binding WHERE enterprise_id = %s AND deleted_at IS NULL "
            "ORDER BY created_at DESC",
            (enterprise_id,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def list_by_sync_status(self, sync_status: str) -> list[RuntimeBinding]:
        self._cur.execute(
            "SELECT id, enterprise_id, owner_type, owner_id, profile_name, "
            "runtime_kind, runtime_session_id, runtime_task_id, runtime_job_id, "
            "sync_status, event_cursor, runtime_source_cursor, "
            "last_synced_at, last_error, "
            "created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM runtime_binding WHERE sync_status = %s AND deleted_at IS NULL "
            "ORDER BY created_at DESC",
            (sync_status,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def update_sync(self, binding: RuntimeBinding) -> RuntimeBinding:
        self._cur.execute(
            "UPDATE runtime_binding SET sync_status=%s, event_cursor=%s, "
            "runtime_source_cursor=%s, "
            "last_synced_at=%s, last_error=%s, "
            "runtime_session_id=%s, runtime_task_id=%s, runtime_job_id=%s, "
            "updated_at=now() WHERE id=%s",
            (binding.sync_status, binding.event_cursor,
             binding.runtime_source_cursor,
             binding.last_synced_at or None, binding.last_error or None,
             binding.runtime_session_id, binding.runtime_task_id,
             binding.runtime_job_id, binding.id),
        )
        return binding

    def delete(self, binding_id: str) -> None:
        self._cur.execute(
            "UPDATE runtime_binding SET deleted_at=now() WHERE id=%s",
            (binding_id,),
        )

    @staticmethod
    def _row_to_entity(row) -> RuntimeBinding:
        return RuntimeBinding(
            id=row[0], enterprise_id=row[1],
            owner_type=row[2], owner_id=row[3],
            profile_name=row[4], runtime_kind=row[5],
            runtime_session_id=row[6],
            runtime_task_id=row[7],
            runtime_job_id=row[8],
            sync_status=row[9],
            event_cursor=row[10],
            runtime_source_cursor=row[11] if row[11] else None,
            last_synced_at=str(row[12]) if row[12] else "",
            last_error=row[13] or "",
            created_at=str(row[14]), updated_at=str(row[15]),
            created_by=row[16] or "", updated_by=row[17] or "",
            deleted_at=str(row[18]) if row[18] else None,
        )
