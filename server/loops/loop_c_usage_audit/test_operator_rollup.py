"""闭环 C · operator_rollup：Manager usage rollup -> Operator 跨企业看板（M8->O3，D13）。

验收锚点：
- Manager 把本租户聚合 rollup 卷成 EnterpriseRollupUpload 上报 Operator。
- Operator 只接收聚合结果（board/detail），不下钻成员/会话明细。
- summary_id 幂等去重（重发不翻倍）。
- 无聚合数据时不上报（空批次安全）。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal

import httpx
import pytest

from manager_service.rollup_reporter import (
    RollupReporter,
    ServiceClientRollupClient,
    UnconfiguredRollupClient,
)
from manager_service.usage_audit_quota_service import UsageAuditQuotaService
from operation_service.rollup_repository import CrossEnterpriseRollupRepository
from operation_service.rollup_service import RollupService
from shared.contracts.summary import UsageSummary
from shared.errors import AppError
from shared.service_client import ServiceClient

from ._helpers import CapturingRollupClient, FakeUsageAuditRepo, tenant_ctx

pytestmark = pytest.mark.integration

_TENANT = "t-1"
_ENT = "ent-a"


def _seed_manager_with_usage(manager, ctx, summaries):
    """直接经 Manager 消费入口落聚合行（模拟 Agent 上报已被消费）。"""
    manager.ingest_upload(ctx, {
        "tenant_id": ctx.tenant_id,
        "usage": [s.model_dump(mode="json") for s in summaries],
        "audits": [],
    })


def _summary(sid, *, run_count=1, token_total=100, cost="1.00", error_count=0, employee=None):
    return UsageSummary(
        summary_id=sid, tenant_id=_TENANT, employee_id=employee,
        window_start=datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc),
        window_end=datetime(2026, 6, 1, 1, 0, tzinfo=timezone.utc),
        run_count=run_count, token_total=token_total, cost_total=Decimal(cost),
        error_count=error_count, duration_seconds_total=10,
    )


def test_manager_rollup_reported_to_operator_board():
    """Manager 聚合 -> EnterpriseRollupUpload -> Operator ingest -> board/detail 可见。"""
    manager = UsageAuditQuotaService(FakeUsageAuditRepo())
    ctx = tenant_ctx(_TENANT, enterprise_id=_ENT)
    _seed_manager_with_usage(manager, ctx, [
        _summary("s1", run_count=2, token_total=150, cost="1.50"),
        _summary("s2", run_count=1, token_total=50, cost="0.50", error_count=1, employee="e2"),
    ])

    client = CapturingRollupClient()
    reporter = RollupReporter(manager)
    out = reporter.report(ctx, enterprise_id=_ENT, client=client)

    assert out["summaries"] == 2
    assert len(client.uploads) == 1
    upload = client.uploads[0]
    assert upload.enterprise_id == _ENT
    assert upload.tenant_id == _TENANT
    assert len(upload.summaries) == 2

    # Operator 消费同一份上报体。
    op = RollupService(CrossEnterpriseRollupRepository())
    op.ingest(upload)
    board = op.cross_enterprise_board()
    assert board.enterprise_count == 1
    assert board.run_count == 3
    assert board.token_total == 200
    assert board.cost_total == Decimal("2.00")
    assert board.error_count == 1

    detail = op.enterprise_rollup(_ENT)
    assert detail.run_count == 3
    assert detail.summary_count == 2


def test_operator_only_receives_aggregated_results_no_drilldown():
    """Operator 看板字段只有聚合数字，无成员/会话/employee 明细下钻通道（D13）。"""
    manager = UsageAuditQuotaService(FakeUsageAuditRepo())
    ctx = tenant_ctx(_TENANT, enterprise_id=_ENT)
    _seed_manager_with_usage(manager, ctx, [
        _summary("s1", employee="alice-secret-employee", token_total=100),
    ])

    client = CapturingRollupClient()
    RollupReporter(manager).report(ctx, enterprise_id=_ENT, client=client)

    op = RollupService(CrossEnterpriseRollupRepository())
    op.ingest(client.uploads[0])
    board_blob = json.dumps(op.cross_enterprise_board().model_dump(mode="json"))
    detail_blob = json.dumps(op.enterprise_rollup(_ENT).model_dump(mode="json"))
    # Operator 视图无 employee_id / 会话字段。
    assert "alice-secret-employee" not in board_blob
    assert "alice-secret-employee" not in detail_blob
    assert "employee" not in board_blob
    for key in ("message", "prompt", "content", "tool_input", "tool_output"):
        assert key not in board_blob
        assert key not in detail_blob


def test_operator_rollup_idempotent_dedup_by_summary_id():
    """同 summary_id 重发不翻倍（04 §6.5 幂等去重）。"""
    manager = UsageAuditQuotaService(FakeUsageAuditRepo())
    ctx = tenant_ctx(_TENANT, enterprise_id=_ENT)
    _seed_manager_with_usage(manager, ctx, [_summary("dup", token_total=100, cost="1.00")])

    client = CapturingRollupClient()
    reporter = RollupReporter(manager)
    reporter.report(ctx, enterprise_id=_ENT, client=client)
    reporter.report(ctx, enterprise_id=_ENT, client=client)  # 重发同批

    op = RollupService(CrossEnterpriseRollupRepository())
    op.ingest(client.uploads[0])
    op.ingest(client.uploads[1])
    row = op.cross_enterprise_board().enterprises[0]
    assert row.token_total == 100  # 不翻倍
    assert row.summary_count == 1


def test_reporter_no_data_does_not_upload():
    """无聚合数据时 report 不上报（空批次安全）。"""
    manager = UsageAuditQuotaService(FakeUsageAuditRepo())
    ctx = tenant_ctx(_TENANT, enterprise_id=_ENT)
    client = CapturingRollupClient()
    out = RollupReporter(manager).report(ctx, enterprise_id=_ENT, client=client)
    assert out["summaries"] == 0
    assert client.uploads == []


def test_unconfigured_rollup_client_safely_refuses():
    """未配置对端不静默成功/不静默丢：upload 抛 AppError。"""
    with pytest.raises(AppError):
        UnconfiguredRollupClient().upload(object(), idempotency_key="k")


def test_service_client_rollup_client_posts_with_idempotency_key():
    """真实 ServiceClient 通道：POST /api/operation/rollups 带 Idempotency-Key（05 §5.1）。"""
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["key"] = request.headers.get("Idempotency-Key")
        return httpx.Response(202, json={"data": None})

    sc = ServiceClient("http://operator.test", transport=httpx.MockTransport(handler))
    ServiceClientRollupClient(sc).upload(
        type("U", (), {"model_dump": lambda self, mode=None: {"enterprise_id": _ENT, "tenant_id": _TENANT, "summaries": []}})(),
        idempotency_key="eru_abc",
    )
    assert seen["path"] == "/api/operation/rollups"
    assert seen["key"] == "eru_abc"
