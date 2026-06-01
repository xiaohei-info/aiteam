"""ConversationMessage repository — persistence for conversation_message table."""

import json

from ..domain.entities import ConversationMessage


class ConversationMessageRepo:
    """Repository for ConversationMessage entity backed by a psycopg cursor."""

    def __init__(self, cur):
        self._cur = cur

    def create(self, msg: ConversationMessage) -> ConversationMessage:
        self._cur.execute(
            "INSERT INTO conversation_message (id, conversation_id, run_id, "
            "sender_id, sender_type, message_text, message_json) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (msg.id, msg.conversation_id, msg.run_id,
             msg.sender_id, msg.sender_type, msg.message_text,
             msg.message_json),
        )
        return msg

    def get_by_id(self, message_id: str):
        self._cur.execute(
            "SELECT id, conversation_id, run_id, sender_id, sender_type, "
            "message_text, message_json, created_at "
            "FROM conversation_message WHERE id = %s",
            (message_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_conversation(self, conversation_id: str) -> list[ConversationMessage]:
        self._cur.execute(
            "SELECT id, conversation_id, run_id, sender_id, sender_type, "
            "message_text, message_json, created_at "
            "FROM conversation_message WHERE conversation_id = %s "
            "ORDER BY created_at",
            (conversation_id,),
        )
        rows = self._cur.fetchall()
        return [self._row_to_entity(r) for r in rows]

    @staticmethod
    def _row_to_entity(row) -> ConversationMessage:
        msg_json = row[6]
        if isinstance(msg_json, dict):
            msg_json = json.dumps(msg_json)
        elif msg_json is None:
            msg_json = "{}"
        else:
            msg_json = str(msg_json)
        return ConversationMessage(
            id=row[0], conversation_id=row[1], run_id=row[2],
            sender_id=row[3] or "", sender_type=row[4] or "user",
            message_text=row[5] or "", message_json=msg_json,
            created_at=str(row[7]) if row[7] else "",
        )
