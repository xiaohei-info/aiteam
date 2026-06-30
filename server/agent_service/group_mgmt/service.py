"""group_mgmt 业务编排——群聊 CRUD + 成员管理 + 消息。

全部本地执行落库；群聊会话内容绝不上传 Manager/Operator。
"""

from __future__ import annotations

from uuid import uuid4

from .store import (
    GroupConversation,
    GroupConversationRepository,
    GroupMember,
    GroupMemberRepository,
    GroupMessage,
    GroupMessageRepository,
)


class GroupMgmtService:
    """用户端群聊管理服务。"""

    def __init__(
        self,
        *,
        conv_store: GroupConversationRepository,
        member_store: GroupMemberRepository,
        msg_store: GroupMessageRepository,
    ) -> None:
        self._conv = conv_store
        self._members = member_store
        self._msgs = msg_store

    # ---- 群聊 CRUD ----

    def create_group(self, group_name: str, employee_ids: list[str]) -> GroupConversation:
        conv = GroupConversation(conversation_id=str(uuid4()), group_name=group_name)
        created = self._conv.create(conv)
        for eid in employee_ids:
            self._members.add(GroupMember(conversation_id=conv.conversation_id, employee_id=eid))
        return created

    def list_groups(self) -> list[GroupConversation]:
        return self._conv.list_active()

    def get_group(self, conversation_id: str) -> GroupConversation | None:
        return self._conv.get(conversation_id)

    def update_group(self, conversation_id: str, group_name: str | None = None) -> GroupConversation | None:
        conv = self._conv.get(conversation_id)
        if conv is None:
            return None
        if group_name is not None:
            conv.group_name = group_name
        return self._conv.update(conv)

    def archive_group(self, conversation_id: str) -> GroupConversation | None:
        return self._conv.archive(conversation_id)

    # ---- 成员管理 ----

    def add_member(self, conversation_id: str, employee_id: str) -> bool:
        if not self._conv.get(conversation_id):
            return False
        if self._members.is_member(conversation_id, employee_id):
            return True  # 幂等：已存在不报错
        self._members.add(GroupMember(conversation_id=conversation_id, employee_id=employee_id))
        return True

    def remove_member(self, conversation_id: str, employee_id: str) -> bool:
        return self._members.remove(conversation_id, employee_id)

    def list_members(self, conversation_id: str) -> list[GroupMember]:
        return self._members.list_by_conversation(conversation_id)

    # ---- 消息 ----

    def send_message(self, conversation_id: str, content: str,
                     author_id: str | None = None, author_name: str | None = None,
                     mentions: list[str] | None = None) -> GroupMessage | None:
        conv = self._conv.get(conversation_id)
        if conv is None or conv.archived:
            return None
        msg = GroupMessage(
            message_id=str(uuid4()),
            conversation_id=conversation_id,
            role="user",
            content=content,
            author_id=author_id,
            author_name=author_name,
            mentions=mentions or [],
        )
        return self._msgs.create(msg)

    def list_messages(self, conversation_id: str, cursor: int = 0) -> list[GroupMessage]:
        return self._msgs.list_by_conversation(conversation_id, cursor=cursor)
