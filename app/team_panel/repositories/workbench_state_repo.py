"""Repositories for workbench user-state preferences and read cursors."""

from __future__ import annotations

from ..domain.entities import ConversationReadState, WorkbenchEmployeePreference


class WorkbenchEmployeePreferenceRepo:
    def __init__(self, cur):
        self._cur = cur

    def list_starred_employee_ids(self, enterprise_id: str, user_id: str) -> set[str]:
        self._cur.execute(
            "SELECT employee_id FROM workbench_employee_preference "
            "WHERE enterprise_id = %s AND user_id = %s AND is_starred = TRUE",
            (enterprise_id, user_id),
        )
        return {row[0] for row in self._cur.fetchall() if row and row[0]}

    def upsert_starred(self, preference: WorkbenchEmployeePreference) -> WorkbenchEmployeePreference:
        self._cur.execute(
            "INSERT INTO workbench_employee_preference "
            "(enterprise_id, user_id, employee_id, is_starred, created_by, updated_by) "
            "VALUES (%s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (enterprise_id, user_id, employee_id) DO UPDATE SET "
            "is_starred = EXCLUDED.is_starred, updated_at = now(), updated_by = EXCLUDED.updated_by",
            (
                preference.enterprise_id,
                preference.user_id,
                preference.employee_id,
                preference.is_starred,
                preference.created_by or None,
                preference.updated_by or None,
            ),
        )
        return preference


class ConversationReadStateRepo:
    def __init__(self, cur):
        self._cur = cur

    def list_by_user(self, enterprise_id: str, user_id: str, conversation_ids: list[str]) -> dict[str, ConversationReadState]:
        if not conversation_ids:
            return {}
        self._cur.execute(
            "SELECT enterprise_id, user_id, conversation_id, last_read_message_id, last_read_at, created_at, updated_at, created_by, updated_by "
            "FROM conversation_read_state "
            "WHERE enterprise_id = %s AND user_id = %s AND conversation_id = ANY(%s)",
            (enterprise_id, user_id, conversation_ids),
        )
        rows = self._cur.fetchall()
        result: dict[str, ConversationReadState] = {}
        for row in rows:
            item = self._row_to_entity(row)
            result[item.conversation_id] = item
        return result

    def upsert_read_state(self, state: ConversationReadState) -> ConversationReadState:
        self._cur.execute(
            "INSERT INTO conversation_read_state "
            "(enterprise_id, user_id, conversation_id, last_read_message_id, last_read_at, created_by, updated_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (enterprise_id, user_id, conversation_id) DO UPDATE SET "
            "last_read_message_id = EXCLUDED.last_read_message_id, "
            "last_read_at = EXCLUDED.last_read_at, "
            "updated_at = now(), "
            "updated_by = EXCLUDED.updated_by",
            (
                state.enterprise_id,
                state.user_id,
                state.conversation_id,
                state.last_read_message_id,
                state.last_read_at or None,
                state.created_by or None,
                state.updated_by or None,
            ),
        )
        return state

    @staticmethod
    def _row_to_entity(row) -> ConversationReadState:
        return ConversationReadState(
            enterprise_id=row[0],
            user_id=row[1],
            conversation_id=row[2],
            last_read_message_id=row[3],
            last_read_at=str(row[4]) if row[4] else "",
            created_at=str(row[5]) if row[5] else "",
            updated_at=str(row[6]) if row[6] else "",
            created_by=row[7] or "",
            updated_by=row[8] or "",
        )
