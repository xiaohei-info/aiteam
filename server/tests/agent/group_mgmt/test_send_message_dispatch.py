"""AITEAM-274 验收：群聊 send_message 落库后必须触发 GroupChatService 编排。

GroupMgmtService.send_message() 不止要存消息到本地库，还要经 MainlineService 调用
GroupChatService.post_and_dispatch()，让被 @ 专家起 run 响应——这是本 issue 所补的缺口。
"""

import asyncio

from agent_service.group_mgmt.store import (
    InMemoryGroupConversationRepository,
    InMemoryGroupMemberRepository,
    InMemoryGroupMessageRepository,
)
from agent_service.group_mgmt.service import GroupMgmtService
from agent_service.mainline.factory import build_mainline_service
from agent_service.mainline.models import RunStatus


def _make_service(*, with_mainline: bool = True):
    conv = InMemoryGroupConversationRepository()
    members = InMemoryGroupMemberRepository()
    msgs = InMemoryGroupMessageRepository()
    mainline = build_mainline_service() if with_mainline else None
    svc = GroupMgmtService(conv_store=conv, member_store=members, msg_store=msgs, mainline=mainline)
    return svc, mainline


def test_send_message_triggers_mention_dispatch():
    """@提及专家时，send_message 必须触发对应专家的 run。"""
    svc, mainline = _make_service()
    g = svc.create_group("技术讨论", ["alice", "bob"])

    msg = asyncio.run(svc.send_message(g.conversation_id, "@alice 请点评一下"))

    # 1) 消息照常落库。
    assert msg is not None
    assert msg.content == "@alice 请点评一下"
    assert msg.role == "user"

    # 2) 编排触发：mainline 上对应会话出现了 run（被 @ 的 alice 起了一个 run）。
    runs = mainline.list_runs(svc._mainline_convs[g.conversation_id])
    assert len(runs) == 1, f"应触发 1 个被 @ 专家的 run，实际 {len(runs)}"
    assert runs[0].status is RunStatus.SUCCEEDED


def test_send_message_without_mention_triggers_nothing():
    """未 @ 任何专家时，不应起 run（消息仍落库）。"""
    svc, mainline = _make_service()
    g = svc.create_group("技术讨论", ["alice", "bob"])

    msg = asyncio.run(svc.send_message(g.conversation_id, "大家好"))

    assert msg is not None
    runs = mainline.list_runs(svc._mainline_convs[g.conversation_id])
    assert runs == [], "未 @ 专家时不应触发 run"


def test_send_message_with_mainline_is_backward_compatible():
    """未注入 mainline 时（backward compat），send_message 仍正常落库、不编排、不报错。"""
    svc, _ = _make_service(with_mainline=False)
    g = svc.create_group("技术讨论", ["alice"])

    msg = asyncio.run(svc.send_message(g.conversation_id, "@alice hi"))

    assert msg is not None
    assert msg.content == "@alice hi"


def test_multiple_mentions_trigger_multiple_runs():
    """多个 @提及应触发多个专家的 run。"""
    svc, mainline = _make_service()
    g = svc.create_group("技术讨论", ["alice", "bob", "carol"])

    asyncio.run(svc.send_message(g.conversation_id, "@alice @carol 请协作"))

    runs = mainline.list_runs(svc._mainline_convs[g.conversation_id])
    assert len(runs) == 2, f"应触发 2 个 run，实际 {len(runs)}"
    assert all(r.status is RunStatus.SUCCEEDED for r in runs)
