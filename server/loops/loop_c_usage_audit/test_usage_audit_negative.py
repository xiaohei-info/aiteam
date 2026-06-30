"""闭环 C · negative：失败旁路与红线负向矩阵（D13/D14/D22/D24）。

验收锚点：
- outbox 上报失败不阻断本地 run，并保留 pending/retry 可观测状态（D14）。
- usage_recorder 抛异常不阻断本地 run（D14，尽力而为副链）。
- quota soft default 不阻断本地 run；hard 仅产出建议、不发 lease（D24）。
- D13：Manager 消费端拒绝含会话内容字段的条目。
- D22：上报体 tenant_id 与身份不一致 -> Forbidden。
- app 装配 _attach_usage_recorder 对不支持 set_usage_recorder 的替身静默跳过。
"""
from __future__ import annotations

import asyncio

import pytest

from agent_gateway.drivers.fake_runtime import FakeDriver, FakeExecutor
from agent_service.app import _attach_usage_recorder
from agent_service.mainline.factory import build_mainline_service
from agent_service.mainline.models import MessageRole, RunStatus
from agent_service.usage.factory import build_run_usage_recorder, build_usage_service
from agent_service.usage.models import RawUsageEvent
from manager_service.usage_audit_quota_service import UsageAuditQuotaService
from shared.errors import Forbidden, ValidationProblem

from ._helpers import (
    FakeUsageAuditRepo,
    RaisingUsageClient,
    quota_in,
    tenant_ctx,
)

pytestmark = pytest.mark.integration


# ---- outbox 上报失败不阻断本地 run（D14）----


def test_outbox_upload_failure_leaves_pending_retry_and_does_not_block_run():
    """run 仍 COMPLETED；flush 失败留 pending + attempts+1 + last_error。"""
    client = RaisingUsageClient()
    usage_service = build_usage_service(client=client)
    mainline = build_mainline_service(
        executor=FakeExecutor(), driver=FakeDriver(), tenant_id="t-1",
        usage_recorder=build_run_usage_recorder(usage_service),
    )
    conv = mainline.create_conversation()
    mainline.add_message(conv.id, role=MessageRole.USER, content="hi")

    run = asyncio.run(mainline.start_run(conv.id))
    # 本地执行成功——与上报副链解耦。
    assert run.status is RunStatus.COMPLETED
    # usage 已入 outbox（pending）。
    assert len(usage_service.pending()) == 1

    result = usage_service.flush()
    assert result.sent == 0
    assert result.failed == 1
    pending = usage_service.pending()
    assert len(pending) == 1, "失败条目留 pending 可观测"
    assert pending[0].attempts == 1
    assert pending[0].last_error and "manager unreachable" in pending[0].last_error

    # 再次 flush 仍可重试（attempts 累加，不丢）。
    usage_service.flush()
    assert usage_service.pending()[0].attempts == 2


def test_usage_recorder_exception_does_not_block_local_run():
    """recorder 回调抛异常时本地 run 仍 COMPLETED（D14 副链吞异常）。"""
    def boom(_tenant, _run_id, _status, _usage, _error):
        raise RuntimeError("outbox 装配炸了")

    mainline = build_mainline_service(
        executor=FakeExecutor(), driver=FakeDriver(), tenant_id="t-1",
        usage_recorder=boom,
    )
    conv = mainline.create_conversation()
    mainline.add_message(conv.id, role=MessageRole.USER, content="hi")
    run = asyncio.run(mainline.start_run(conv.id))
    assert run.status is RunStatus.COMPLETED  # 副链失败不阻断主链


# ---- quota soft/hard 不阻断本地 run（D24）----


@pytest.mark.pr_quick
def test_quota_soft_default_does_not_block_run():
    """soft 配额超阈只产出告警/建议，不阻断；本地 run 不感知配额评估。"""
    manager = UsageAuditQuotaService(FakeUsageAuditRepo())
    ctx = tenant_ctx("t-1")
    from datetime import datetime, timezone
    w0, w1 = datetime(2026, 6, 1, tzinfo=timezone.utc), datetime(2026, 6, 30, tzinfo=timezone.utc)
    policy = manager.create_quota(ctx, quota_in("cost-cap", enforcement="soft",
                                                dimensions={"cost_cap_usd": "1.00", "run_cap": 1}))
    # 落入超过阈值的 usage。
    manager.ingest_upload(ctx, {
        "tenant_id": ctx.tenant_id,
        "usage": [{
            "summary_id": "s1", "employee_id": None,
            "window_start": "2026-06-01T00:00:00Z", "window_end": "2026-06-01T01:00:00Z",
            "run_count": 5, "token_total": 500, "cost_total": "9.00",
            "error_count": 0, "duration_seconds_total": 10,
        }],
        "audits": [],
    })
    action = manager.evaluate_quota(ctx, policy_id=policy.policy_id, window_start=w0, window_end=w1)
    assert "notify_owner" in action.actions
    assert "suggest_throttle" in action.actions
    # soft 不产出 block_new_runs（D24 默认 soft 不阻断）。
    assert "block_new_runs" not in action.actions

    # 本地 run 不感知：起一条 run 仍成功（配额评估是独立治理读，不在 run 路径）。
    mainline = build_mainline_service(executor=FakeExecutor(), driver=FakeDriver(), tenant_id="t-1")
    conv = mainline.create_conversation()
    mainline.add_message(conv.id, role=MessageRole.USER, content="go")
    assert asyncio.run(mainline.start_run(conv.id)).status is RunStatus.COMPLETED


def test_quota_hard_emits_block_suggestion_but_still_no_lease():
    """hard 配额产出 block_new_runs 建议但仍非 lease——本地 run 不被强制阻断。"""
    manager = UsageAuditQuotaService(FakeUsageAuditRepo())
    ctx = tenant_ctx("t-1")
    from datetime import datetime, timezone
    w0, w1 = datetime(2026, 6, 1, tzinfo=timezone.utc), datetime(2026, 6, 30, tzinfo=timezone.utc)
    policy = manager.create_quota(ctx, quota_in("hard-cap", enforcement="hard",
                                                dimensions={"run_cap": 1}))
    manager.ingest_upload(ctx, {
        "tenant_id": ctx.tenant_id,
        "usage": [{
            "summary_id": "s1", "employee_id": None,
            "window_start": "2026-06-01T00:00:00Z", "window_end": "2026-06-01T01:00:00Z",
            "run_count": 5, "token_total": 0, "cost_total": "0",
            "error_count": 0, "duration_seconds_total": 0,
        }],
        "audits": [],
    })
    action = manager.evaluate_quota(ctx, policy_id=policy.policy_id, window_start=w0, window_end=w1)
    assert "block_new_runs" in action.actions  # 建议存在
    # 但无 quota lease：本地 run 仍可起（详设须显式标记牺牲离线可用性才阻断）。
    mainline = build_mainline_service(executor=FakeExecutor(), driver=FakeDriver(), tenant_id="t-1")
    conv = mainline.create_conversation()
    mainline.add_message(conv.id, role=MessageRole.USER, content="go")
    assert asyncio.run(mainline.start_run(conv.id)).status is RunStatus.COMPLETED


# ---- D13 红线：消费端拒绝会话内容 ----


def test_manager_rejects_usage_item_with_conversation_content():
    manager = UsageAuditQuotaService(FakeUsageAuditRepo())
    ctx = tenant_ctx("t-1")
    with pytest.raises(ValidationProblem):
        manager.ingest_upload(ctx, {
            "tenant_id": ctx.tenant_id,
            "usage": [{
                "summary_id": "s1", "employee_id": None,
                "window_start": "2026-06-01T00:00:00Z", "window_end": "2026-06-01T01:00:00Z",
                "run_count": 1, "token_total": 1, "cost_total": "0",
                "error_count": 0, "duration_seconds_total": 0,
                "message": "夹带的会话明文",  # D13 禁止字段
            }],
            "audits": [],
        })


def test_manager_rejects_quota_dimensions_with_conversation_content():
    manager = UsageAuditQuotaService(FakeUsageAuditRepo())
    ctx = tenant_ctx("t-1")
    with pytest.raises(ValidationProblem):
        manager.create_quota(ctx, quota_in("bad", dimensions={"prompt": "会话内容"}))


# ---- D22：租户不一致拒绝 ----


def test_manager_rejects_tenant_mismatch_upload():
    manager = UsageAuditQuotaService(FakeUsageAuditRepo())
    ctx = tenant_ctx("t-1")
    with pytest.raises(Forbidden):
        manager.ingest_upload(ctx, {
            "tenant_id": "other-tenant",  # 与身份不一致
            "usage": [], "audits": [],
        })


# ---- app 装配：替身无 set_usage_recorder 时静默跳过 ----


def test_attach_usage_recorder_skips_unsupported_mainline():
    class _BareMainline:
        pass

    usage_service = build_usage_service(client=RaisingUsageClient())
    _attach_usage_recorder(_BareMainline(), usage_service)  # 不应抛
