"""Enterprise repository — persistence for enterprise table."""
from typing import Optional

from ..domain.entities import Enterprise


class EnterpriseRepo:
    """Repository for Enterprise entity backed by a psycopg2 cursor."""

    def __init__(self, cur):
        self._cur = cur

    def create(self, ent: Enterprise) -> Enterprise:
        self._cur.execute(
            "INSERT INTO enterprise (id, slug, name, status, owner_user_id, default_workspace_id) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (ent.id, ent.slug, ent.name, ent.status, ent.owner_user_id, ent.default_workspace_id),
        )
        return ent

    def get_by_id(self, enterprise_id: str) -> Optional[Enterprise]:
        self._cur.execute(
            "SELECT id, slug, name, status, owner_user_id, default_workspace_id, "
            "archive_reason, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM enterprise WHERE id = %s",
            (enterprise_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return Enterprise(
            id=row[0], slug=row[1], name=row[2], status=row[3],
            owner_user_id=row[4], default_workspace_id=row[5],
            archive_reason=row[6], created_at=str(row[7]), updated_at=str(row[8]),
            created_by=row[9] or "", updated_by=row[10] or "",
            deleted_at=str(row[11]) if row[11] else None,
        )

    def list_all(self) -> list[Enterprise]:
        self._cur.execute(
            "SELECT id, slug, name, status, owner_user_id, default_workspace_id, "
            "archive_reason, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM enterprise ORDER BY created_at"
        )
        rows = self._cur.fetchall()
        results = []
        for row in rows:
            results.append(Enterprise(
                id=row[0], slug=row[1], name=row[2], status=row[3],
                owner_user_id=row[4], default_workspace_id=row[5],
                archive_reason=row[6], created_at=str(row[7]), updated_at=str(row[8]),
                created_by=row[9] or "", updated_by=row[10] or "",
                deleted_at=str(row[11]) if row[11] else None,
            ))
        return results

    def update(self, ent: Enterprise) -> Enterprise:
        self._cur.execute(
            "UPDATE enterprise SET name=%s, status=%s, archive_reason=%s, "
            "updated_at=now() WHERE id=%s",
            (ent.name, ent.status, ent.archive_reason, ent.id),
        )
        return ent

    def delete(self, enterprise_id: str) -> None:
        self._cur.execute(
            "UPDATE enterprise SET deleted_at=now() WHERE id=%s",
            (enterprise_id,),
        )
