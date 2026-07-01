"""group_mgmt 服务装配。"""

from __future__ import annotations

from agent_service.local_db import LocalDb
from agent_service.mainline.service import MainlineService

from .service import GroupMgmtService
from .store import (
    GroupConversationRepository,
    GroupMemberRepository,
    GroupMessageRepository,
    InMemoryGroupConversationRepository,
    InMemoryGroupMemberRepository,
    InMemoryGroupMessageRepository,
    SqliteGroupConversationRepository,
    SqliteGroupMemberRepository,
    SqliteGroupMessageRepository,
)


def build_group_mgmt_service(
    *,
    db: LocalDb | None = None,
    mainline: MainlineService | None = None,
) -> GroupMgmtService:
    conv_store: GroupConversationRepository = (
        SqliteGroupConversationRepository(db) if db else InMemoryGroupConversationRepository()
    )
    member_store: GroupMemberRepository = (
        SqliteGroupMemberRepository(db) if db else InMemoryGroupMemberRepository()
    )
    msg_store: GroupMessageRepository = (
        SqliteGroupMessageRepository(db) if db else InMemoryGroupMessageRepository()
    )
    return GroupMgmtService(
        conv_store=conv_store,
        member_store=member_store,
        msg_store=msg_store,
        mainline=mainline,
    )
