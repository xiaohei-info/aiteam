"""闭环 C · outbox_to_manager：Agent outbox flush -> Manager usage/audit rollup 消费（A5->M8/F13）。

验收锚点：
- Agent 脱敏摘要经 outbox flush 上报 Manager，Manager 消费落聚合 rollup。
- Manager usage 无会话文本/文件/工具 I/O 明细（D13）。
- 上报体 tenant_id 与 Manager 身份一致（D22）。
"""
from __future__ import annotations

import json

import pytest

from agent_service.usage.factory import build_usage_service
from agent_service.usage.models import RawAuditEvent, RawUsageEvent
from manager_service.usage_audit_quota_service import UsageAuditQuotaService

from ._helpers import CapturingUsageClient, FakeUsageAuditRepo, tenant_ctx

pytestmark = pytest.mark.integration

_TENANT = "t-1"


def _agent_service(client=None):
    return build_usage_service(client=client or CapturingUsageClient())


def test_outbox_flush_delivers_usage_summary_to_manager():
    """Agent record_usage -> flush -> Manager ingest_upload -> list_usage 可见聚合。"""
    client = CapturingUsageClient()
    svc = _agent_service(client)
    svc.record_usage(_TENANT, [
        RawUsageEvent(run_id="r1", employee_id="e1",
                      usage={"input_tokens": 12, "output_tokens": 8, "cost": "0.05"}),
        RawUsageEvent(run_id="r2", employee_id="e1",
                      usage={"total_tokens": 40, "cost": "0.10"}, error=True),
    ])
    result = svc.flush()
    assert result.sent == 1

    # Manager 消费同一份上报体。
    manager = UsageAuditQuotaService(FakeUsageAuditRepo())
    ctx = tenant_ctx(_TENANT)
    upload = client.uploads[0]
    ingest = manager.ingest_upload(ctx, upload.model_dump(mode="json"))
    assert ingest["usage_ingested"] == 1  # 同 employee+窗口聚合为 1 条

    rows = manager.list_usage(ctx)
    assert len(rows) == 1
    row = rows[0]
    assert row.run_count == 2
    assert row.token_total == 60  # (12+8) + 40
    assert row.error_count == 1


def test_outbox_flush_delivers_audit_summary_to_manager():
    """Agent record_audits -> flush -> Manager ingest -> list_audits 可见脱敏审计。"""
    client = CapturingUsageClient()
    svc = _agent_service(client)
    svc.record_audits(_TENANT, [
        RawAuditEvent(actor="u1", action="login"),
        RawAuditEvent(actor="u2", action="grant_change", resource_type="expert", resource_id="ex-1"),
    ])
    svc.flush()

    manager = UsageAuditQuotaService(FakeUsageAuditRepo())
    ctx = tenant_ctx(_TENANT)
    manager.ingest_upload(ctx, client.uploads[0].model_dump(mode="json"))

    audits = manager.list_audits(ctx)
    assert len(audits) == 2
    actions = {a.action for a in audits}
    assert actions == {"login", "grant_change"}


def test_manager_ingested_usage_has_no_conversation_content():
    """D13：上报到 Manager 的 payload 不含会话文本/文件/工具 I/O 明细。"""
    client = CapturingUsageClient()
    svc = _agent_service(client)
    # 原始事件夹带会话敏感物——脱敏应在上报前完成。
    svc.record_usage(_TENANT, [
        RawUsageEvent(
            run_id="r1", usage={"input_tokens": 5, "output_tokens": 3},
            prompt="用户的私密会话内容：银行卡密码 123456",
            completion="助手回复的绝密商业方案",
            messages=[{"role": "user", "content": "secret"}],
            file_path="/Users/alice/secret-deck.pdf",
        ),
    ])
    svc.record_audits(_TENANT, [
        RawAuditEvent(actor="u1", action="login", note="夹带的会话明文"),
    ])
    svc.flush()

    blob = json.dumps(client.uploads[0].model_dump(mode="json"))
    for secret in ("私密会话内容", "银行卡密码", "绝密商业方案", "secret-deck.pdf", "夹带的会话明文"):
        assert secret not in blob, f"上报 payload 泄漏敏感物：{secret}"

    # Manager 消费后落库的聚合行同样不含会话内容字段。
    manager = UsageAuditQuotaService(FakeUsageAuditRepo())
    ctx = tenant_ctx(_TENANT)
    manager.ingest_upload(ctx, client.uploads[0].model_dump(mode="json"))
    rows_blob = json.dumps([r.__dict__ for r in manager.list_usage(ctx)], default=str)
    for secret in ("私密会话内容", "银行卡密码", "绝密商业方案", "secret-deck.pdf"):
        assert secret not in rows_blob
