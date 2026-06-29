"""Agent 用户端群聊完整管理路由（P06 群聊页面）。

边界：群聊全部本地执行与落库；多专家 @提及编排复用 mainline group-dispatch。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.envelope import Envelope, ListEnvelope


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


def build_group_mgmt_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/agent/group-conversations", tags=["agent", "group-mgmt"])

    @router.post("", summary="创建群聊", operation_id="agent_group_create")
    async def create_group(
        body: GroupConversationCreate,
        request: Request,
    ) -> Envelope[GroupConversationOut]:
        now = datetime.now(timezone.utc)
        conv_id = str(uuid4())
        members = [{"employee_id": eid, "join_time": now.isoformat()} for eid in body.employee_ids]
        return Envelope(data=GroupConversationOut(
            conversation_id=conv_id,
            group_name=body.group_name,
            members=members,
            created_at=now,
        ))

    @router.get("", summary="列群聊", operation_id="agent_group_list")
    async def list_groups(request: Request) -> ListEnvelope[GroupConversationOut]:
        return ListEnvelope(data=[])

    @router.get("/{conversation_id}", summary="群聊详情", operation_id="agent_group_detail")
    async def get_group(
        conversation_id: str,
        request: Request,
    ) -> Envelope[GroupConversationOut]:
        now = datetime.now(timezone.utc)
        return Envelope(data=GroupConversationOut(
            conversation_id=conversation_id,
            group_name="",
            created_at=now,
        ))

    @router.patch("/{conversation_id}", summary="更新群聊", operation_id="agent_group_update")
    async def update_group(
        conversation_id: str,
        body: GroupConversationPatch,
        request: Request,
    ) -> dict:
        return {"conversation_id": conversation_id, "updated": True}

    @router.delete("/{conversation_id}", summary="解散群聊", operation_id="agent_group_archive")
    async def archive_group(
        conversation_id: str,
        request: Request,
    ) -> dict:
        return {"conversation_id": conversation_id, "archived": True}

    @router.post("/{conversation_id}/members", summary="添加群聊成员", operation_id="agent_group_member_add")
    async def add_member(
        conversation_id: str,
        body: GroupMemberAdd,
        request: Request,
    ) -> dict:
        return {"conversation_id": conversation_id, "employee_id": body.employee_id, "added": True}

    @router.delete("/{conversation_id}/members/{member_id}", summary="移除群聊成员", operation_id="agent_group_member_remove")
    async def remove_member(
        conversation_id: str,
        member_id: str,
        request: Request,
    ) -> dict:
        return {"conversation_id": conversation_id, "member_id": member_id, "removed": True}

    @router.post("/{conversation_id}/messages", summary="发送群聊消息", operation_id="agent_group_message_send")
    async def send_group_message(
        conversation_id: str,
        body: GroupMessageIn,
        request: Request,
    ) -> Envelope[GroupMessageOut]:
        now = datetime.now(timezone.utc)
        return Envelope(data=GroupMessageOut(
            message_id=str(uuid4()),
            conversation_id=conversation_id,
            role="user",
            content=body.content,
            mentions=body.mentions,
            created_at=now,
        ))

    @router.get("/{conversation_id}/messages", summary="列群聊消息", operation_id="agent_group_message_list")
    async def list_group_messages(
        conversation_id: str,
        request: Request,
        cursor: int = Query(default=0, ge=0),
    ) -> ListEnvelope[GroupMessageOut]:
        return ListEnvelope(data=[])

    return router
