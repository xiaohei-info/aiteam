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

    def list_with_filter(
        self,
        name: Optional[str] = None,
        status: Optional[str] = None,
        created_from: Optional[str] = None,
        created_to: Optional[str] = None,
        page: int = 1,
        limit: int = 20,
    ) -> tuple[list[Enterprise], int]:
        """List enterprises with optional search/filter and pagination."""
        conditions = ["deleted_at IS NULL"]
        params: list = []

        if name:
            conditions.append("(name ILIKE %s OR slug ILIKE %s)")
            like = f"%{name}%"
            params.extend([like, like])

        if status:
            conditions.append("status = %s")
            params.append(status)

        if created_from:
            conditions.append("created_at::date >= %s::date")
            params.append(created_from)

        if created_to:
            conditions.append("created_at::date <= %s::date")
            params.append(created_to)

        where_clause = " AND ".join(conditions)

        self._cur.execute(
            f"SELECT COUNT(*) FROM enterprise WHERE {where_clause}",
            tuple(params),
        )
        total = self._cur.fetchone()[0]

        offset = (page - 1) * limit
        self._cur.execute(
            f"SELECT id, slug, name, status, owner_user_id, default_workspace_id, "
            f"archive_reason, created_at, updated_at, created_by, updated_by, deleted_at "
            f"FROM enterprise WHERE {where_clause} "
            f"ORDER BY created_at DESC LIMIT %s OFFSET %s",
            tuple(params) + (limit, offset),
        )
        rows = self._cur.fetchall()
        items = []
        for row in rows:
            items.append(Enterprise(
                id=row[0], slug=row[1], name=row[2], status=row[3],
                owner_user_id=row[4], default_workspace_id=row[5],
                archive_reason=row[6], created_at=str(row[7]), updated_at=str(row[8]),
                created_by=row[9] or "", updated_by=row[10] or "",
                deleted_at=str(row[11]) if row[11] else None,
            ))
        return items, total

    def delete(self, enterprise_id: str) -> None:
        self._cur.execute(
            "UPDATE enterprise SET deleted_at=now() WHERE id=%s",
            (enterprise_id,),
        )
