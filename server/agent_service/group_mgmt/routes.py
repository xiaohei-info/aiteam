"""group_mgmt 路由——群聊创建/更新/成员/消息/归档。

薄路由层：HTTP 契约映射，业务委托给 GroupMgmtService。
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.envelope import Envelope, ListEnvelope

from .service import GroupMgmtService


def _now() -> datetime:
    return datetime.now(timezone.utc)


class GroupConversationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    group_name: str
    employee_ids: list[str] = Field(min_length=1, max_length=10)


class GroupConversationOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_id: str
    group_name: str
    members: list[dict] = Field(default_factory=list)
    created_at: datetime


class GroupConversationPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    group_name: str | None = None


class GroupMemberAdd(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_id: str


class GroupMessageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str
    mentions: list[str] = Field(default_factory=list, description="@提及的 employee_id 列表")


class GroupMessageOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message_id: str
    conversation_id: str
    role: str
    content: str
    author_id: str | None = None
    author_name: str | None = None
    mentions: list[str] = Field(default_factory=list)
    created_at: datetime


def build_group_mgmt_router(service: GroupMgmtService) -> APIRouter:
    router = APIRouter(prefix="/api/agent/group-conversations", tags=["agent", "group-mgmt"])

    @router.post("", summary="创建群聊", operation_id="agent_group_create")
    async def create_group(
        body: GroupConversationCreate,
        request: Request,
    ) -> Envelope[GroupConversationOut]:
        conv = service.create_group(body.group_name, body.employee_ids)
        members = [
            {"employee_id": m.employee_id, "join_time": m.joined_at}
            for m in service.list_members(conv.conversation_id)
        ]
        return Envelope(data=GroupConversationOut(
            conversation_id=conv.conversation_id,
            group_name=conv.group_name,
            members=members,
            created_at=datetime.fromisoformat(conv.created_at),
        ))

    @router.get("", summary="列群聊", operation_id="agent_group_list")
    async def list_groups(request: Request) -> ListEnvelope[GroupConversationOut]:
        convs = service.list_groups()
        return ListEnvelope(data=[
            GroupConversationOut(
                conversation_id=c.conversation_id,
                group_name=c.group_name,
                members=[
                    {"employee_id": m.employee_id, "join_time": m.joined_at}
                    for m in service.list_members(c.conversation_id)
                ],
                created_at=datetime.fromisoformat(c.created_at),
            )
            for c in convs
        ])

    @router.get("/{conversation_id}", summary="群聊详情", operation_id="agent_group_detail")
    async def get_group(
        conversation_id: str,
        request: Request,
    ) -> Envelope[GroupConversationOut]:
        conv = service.get_group(conversation_id)
        if conv is None:
            from shared.errors import NotFound
            raise NotFound(f"group conversation not found: {conversation_id}")
        members = [
            {"employee_id": m.employee_id, "join_time": m.joined_at}
            for m in service.list_members(conv.conversation_id)
        ]
        return Envelope(data=GroupConversationOut(
            conversation_id=conv.conversation_id,
            group_name=conv.group_name,
            members=members,
            created_at=datetime.fromisoformat(conv.created_at),
        ))

    @router.patch("/{conversation_id}", summary="更新群聊", operation_id="agent_group_update")
    async def update_group(
        conversation_id: str,
        body: GroupConversationPatch,
        request: Request,
    ) -> dict:
        conv = service.update_group(conversation_id, group_name=body.group_name)
        if conv is None:
            from shared.errors import NotFound
            raise NotFound(f"group conversation not found: {conversation_id}")
        return Envelope(data={"conversation_id": conversation_id, "updated": True})

    @router.delete("/{conversation_id}", summary="解散群聊", operation_id="agent_group_archive")
    async def archive_group(
        conversation_id: str,
        request: Request,
    ) -> dict:
        conv = service.archive_group(conversation_id)
        if conv is None:
            from shared.errors import NotFound
            raise NotFound(f"group conversation not found: {conversation_id}")
        return Envelope(data={"conversation_id": conversation_id, "archived": True})

    @router.post("/{conversation_id}/members", summary="添加群聊成员", operation_id="agent_group_member_add")
    async def add_member(
        conversation_id: str,
        body: GroupMemberAdd,
        request: Request,
    ) -> dict:
        ok = service.add_member(conversation_id, body.employee_id)
        if not ok:
            from shared.errors import NotFound
            raise NotFound(f"group conversation not found: {conversation_id}")
        return Envelope(data={"conversation_id": conversation_id, "employee_id": body.employee_id, "added": True})

    @router.delete("/{conversation_id}/members/{member_id}", summary="移除群聊成员", operation_id="agent_group_member_remove")
    async def remove_member(
        conversation_id: str,
        member_id: str,
        request: Request,
    ) -> dict:
        service.remove_member(conversation_id, member_id)
        return Envelope(data={"conversation_id": conversation_id, "member_id": member_id, "removed": True})

    @router.post("/{conversation_id}/messages", summary="发送群聊消息", operation_id="agent_group_message_send")
    async def send_group_message(
        conversation_id: str,
        body: GroupMessageIn,
        request: Request,
    ) -> Envelope[GroupMessageOut]:
        msg = service.send_message(
            conversation_id=conversation_id,
            content=body.content,
            mentions=body.mentions,
        )
        if msg is None:
            from shared.errors import NotFound
            raise NotFound(f"group conversation not found or archived: {conversation_id}")
        return Envelope(data=GroupMessageOut(
            message_id=msg.message_id,
            conversation_id=msg.conversation_id,
            role=msg.role,
            content=msg.content,
            author_id=msg.author_id,
            author_name=msg.author_name,
            mentions=msg.mentions,
            created_at=datetime.fromisoformat(msg.created_at),
        ))

    @router.get("/{conversation_id}/messages", summary="列群聊消息", operation_id="agent_group_message_list")
    async def list_group_messages(
        conversation_id: str,
        request: Request,
        cursor: int = Query(default=0, ge=0),
    ) -> ListEnvelope[GroupMessageOut]:
        msgs = service.list_messages(conversation_id, cursor=cursor)
        return ListEnvelope(data=[
            GroupMessageOut(
                message_id=m.message_id,
                conversation_id=m.conversation_id,
                role=m.role,
                content=m.content,
                author_id=m.author_id,
                author_name=m.author_name,
                mentions=m.mentions,
                created_at=datetime.fromisoformat(m.created_at),
            )
            for m in msgs
        ])

    return router
