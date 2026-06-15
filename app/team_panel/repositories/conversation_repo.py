"""Conversation repository — persistence for conversation table."""
from typing import Optional

from ..domain.entities import Conversation


class ConversationRepo:
    """Repository for Conversation entity backed by a psycopg cursor."""

    def __init__(self, cur):
        self._cur = cur

    def create(self, conv: Conversation) -> Conversation:
        self._cur.execute(
            "INSERT INTO conversation (id, enterprise_id, type, status, title, "
            "entry_employee_id, latest_run_id, latest_message_id, last_message_preview, created_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (conv.id, conv.enterprise_id, conv.type, conv.status, conv.title,
             conv.entry_employee_id, conv.latest_run_id,
             conv.latest_message_id, conv.last_message_preview, conv.created_by),
        )
        return conv

    def get_by_id(self, conversation_id: str) -> Optional[Conversation]:
        self._cur.execute(
            "SELECT id, enterprise_id, type, status, title, entry_employee_id, "
            "latest_run_id, latest_message_id, last_message_preview, last_message_at, "
            "created_by, archived_at, created_at, updated_at, updated_by, deleted_at "
            "FROM conversation WHERE id = %s",
            (conversation_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_enterprise(self, enterprise_id: str) -> list[Conversation]:
        self._cur.execute(
            "SELECT id, enterprise_id, type, status, title, entry_employee_id, "
            "latest_run_id, latest_message_id, last_message_preview, last_message_at, "
            "created_by, archived_at, created_at, updated_at, updated_by, deleted_at "
            "FROM conversation WHERE enterprise_id = %s AND deleted_at IS NULL "
            "ORDER BY created_at DESC",
            (enterprise_id,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def list_private_by_employee(
        self, enterprise_id: str, employee_id: str
    ) -> list[Conversation]:
        """Private conversation history for one employee, newest-first.

        Excludes group conversations and soft-deleted rows. Ordered by last
        activity (last_message_at, falling back to created_at) so the most
        recently used conversation surfaces first.
        """
        self._cur.execute(
            "SELECT id, enterprise_id, type, status, title, entry_employee_id, "
            "latest_run_id, latest_message_id, last_message_preview, last_message_at, "
            "created_by, archived_at, created_at, updated_at, updated_by, deleted_at "
            "FROM conversation "
            "WHERE enterprise_id = %s AND entry_employee_id = %s "
            "AND type = 'private' AND deleted_at IS NULL "
            "ORDER BY COALESCE(last_message_at, created_at) DESC, created_at DESC",
            (enterprise_id, employee_id),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    def update_status(self, conv: Conversation) -> Conversation:
        self._cur.execute(
            "UPDATE conversation SET status=%s, title=%s, "
            "last_message_preview=%s, updated_at=now() "
            "WHERE id=%s",
            (conv.status, conv.title, conv.last_message_preview, conv.id),
        )
        return conv

    def update_latest_run(self, conversation_id: str,
                          run_id: str, message_id: str, preview: str) -> None:
        self._cur.execute(
            "UPDATE conversation SET latest_run_id=%s, "
            "latest_message_id=%s, last_message_preview=%s, "
            "last_message_at=now(), updated_at=now() WHERE id=%s",
            (run_id, message_id, preview, conversation_id),
        )

    def delete(self, conversation_id: str) -> None:
        self._cur.execute(
            "UPDATE conversation SET deleted_at=now() WHERE id=%s",
            (conversation_id,),
        )

    @staticmethod
    def _row_to_entity(row) -> Conversation:
        return Conversation(
            id=row[0], enterprise_id=row[1], type=row[2], status=row[3],
            title=row[4] or "", entry_employee_id=row[5],
            latest_run_id=row[6],
            latest_message_id=row[7],
            last_message_preview=row[8],
            last_message_at=str(row[9]) if row[9] else "",
            created_by=row[10] or "",
            archived_at=str(row[11]) if row[11] else "",
            created_at=str(row[12]), updated_at=str(row[13]),
            updated_by=row[14] or "",
            deleted_at=str(row[15]) if row[15] else None,
        )
