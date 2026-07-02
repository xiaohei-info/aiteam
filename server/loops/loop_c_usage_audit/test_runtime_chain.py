"""闭环 C · runtime chain：Agent conversation/message/run/group dispatch/loop 主路径（A1/A2/A3）。

验收锚点：Agent runtime chain 可完成 conversation/message/run/group dispatch/loop 主路径；
本地执行成功与摘要上报成功**分别断言**（outbox flush 是独立副链，二者不耦合）。

全内存 + Fake runtime（非目标：不启动真实外部 LLM provider）。run 终态 usage 经
MainlineService.usage_recorder 回流进 outbox，flush 后由 CapturingUsageClient 捕获。
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from agent_gateway.drivers.fake_runtime import FakeDriver, FakeExecutor
from agent_service.loop.factory import build_loop_service
from agent_service.mainline.factory import build_mainline_service
from agent_service.mainline.group import GroupChatService, GroupExpert
from agent_service.mainline.models import MessageRole, RunStatus
from agent_service.usage.factory import build_run_usage_recorder, build_usage_service

from ._helpers import CapturingUsageClient

pytestmark = pytest.mark.integration


def _wired(*, tenant_id: str = "t-1"):
    """装配一条回流闭环：MainlineService(fake runtime) + UsageService(capturing client)。"""
    client = CapturingUsageClient()
    usage_service = build_usage_service(client=client)
    mainline = build_mainline_service(
        executor=FakeExecutor(),
        driver=FakeDriver(),
        tenant_id=tenant_id,
        usage_recorder=build_run_usage_recorder(usage_service),
    )
    return mainline, usage_service, client


def test_runtime_chain_run_completes_and_usage_reaches_outbox():
    """conversation -> message -> run：本地 run COMPLETED，usage 回流进 outbox pending。"""
    mainline, usage_service, _client = _wired()
    conv = mainline.create_conversation(title="闭环C")
    mainline.add_message(conv.id, role=MessageRole.USER, content="你好")

    run = asyncio.run(mainline.start_run(conv.id))

    # 本地执行成功（独立断言，不依赖上报）。
    assert run.status is RunStatus.SUCCEEDED
    assert run.usage == {"input_tokens": 10, "output_tokens": 5}
    # usage 已回流进 outbox（pending，尚未 flush）。
    pending = usage_service.pending()
    assert len(pending) == 1
    assert pending[0].usage is not None
    assert pending[0].usage.token_total == 15  # 10 + 5（input+output 归一）


def test_runtime_chain_local_success_and_upload_success_asserted_separately():
    """本地执行成功（Run.status）与摘要上报成功（client.uploads）分两条断言、互不耦合。"""
    mainline, usage_service, client = _wired()
    conv = mainline.create_conversation()
    mainline.add_message(conv.id, role=MessageRole.USER, content="再跑一次")

    run = asyncio.run(mainline.start_run(conv.id))
    result = usage_service.flush()

    # 断言一：本地执行成功。
    assert run.status is RunStatus.SUCCEEDED
    # 断言二：摘要上报成功（独立副链）。
    assert result.sent == 1 and result.failed == 0
    assert len(client.uploads) == 1
    upload = client.uploads[0]
    assert upload.tenant_id == "t-1"
    assert upload.usage and upload.usage[0].token_total == 15
    assert upload.usage[0].run_count == 1


def test_runtime_chain_group_dispatch_multi_run_usage_recorded():
    """群聊 @提及多专家各起一个 run；多 run usage 并入同一 outbox，flush 聚合上报。"""
    mainline, usage_service, client = _wired()
    grp = GroupChatService(mainline, experts=[
        GroupExpert(handle="alice", system_prompt="你是 Alice"),
        GroupExpert(handle="bob", system_prompt="你是 Bob"),
    ])
    conv = grp.mainline.create_conversation(title="群聊")

    result = asyncio.run(grp.post_and_dispatch(conv.id, "@alice @bob 协作一下"))

    # 本地：两个专家各起一个 run，均成功。
    assert sorted(result.triggered_handles) == ["alice", "bob"]
    assert all(r.status is RunStatus.SUCCEEDED for r in result.runs)
    assert len(result.runs) == 2
    # 回流：两个 run 的 usage 均回流进 outbox（同 tenant/窗口/employee 聚合为一条 summary）。
    # 计费级精度为非目标；此处断言闭环可达——usage 入 outbox 且 flush 上报成功。
    pending = usage_service.pending()
    assert len(pending) == 1
    assert pending[0].usage is not None
    assert pending[0].tenant_id == "t-1"
    flushed = usage_service.flush()
    assert flushed.sent == 1
    assert len(client.uploads) == 1  # 同 tenant 一批上报
    assert client.uploads[0].tenant_id == "t-1"
    assert client.uploads[0].usage, "群聊多 run usage 已上报到 Manager"


def test_runtime_chain_loop_scheduler_triggers_run_and_records_usage():
    """Loop 到点触发复用 MainlineService.start_run；usage 同样回流进 outbox。"""
    mainline, usage_service, client = _wired()
    loop_service, scheduler = build_loop_service(mainline=mainline)
    conv = mainline.create_conversation()
    loop_service.create_loop(
        conversation_id=conv.id, cron="* * * * *", enabled=True,
        run_spec=None, title="每分钟巡检",
    )

    outcomes = asyncio.run(scheduler.fire_ready(datetime(2026, 6, 19, 0, 0, tzinfo=timezone.utc)))

    assert len(outcomes) == 1 and outcomes[0].ok
    run = mainline.get_run(outcomes[0].run_id)
    assert run.status is RunStatus.SUCCEEDED
    # loop 触发的 run 与普通 run 走同一条回流链路。
    assert len(usage_service.pending()) == 1
    flushed = usage_service.flush()
    assert flushed.sent == 1
    assert client.uploads[0].usage[0].token_total == 15
