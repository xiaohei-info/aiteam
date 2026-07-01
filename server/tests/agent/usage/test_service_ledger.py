"""A5 审计回流端到端：record_usage 同时写 outbox（聚合摘要）与 usage_ledger（per-run 明细）。(#293)"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from agent_service.usage.factory import build_usage_service
from agent_service.usage.models import RawUsageEvent


def _svc():
    return build_usage_service()


def test_record_usage_writes_outbox_and_ledger():
    svc = _svc()
    events = [
        RawUsageEvent(run_id="r1", employee_id="e1",
                      usage={"input_tokens": 10, "output_tokens": 5, "cost": "0.0030"},
                      duration_seconds=3, error=True),
        RawUsageEvent(run_id="r2", employee_id="e1",
                      usage={"input_tokens": 7, "output_tokens": 3, "cost": "0.0020"},
                      duration_seconds=1),
    ]
    svc.record_usage("t1", events)

    # 1) outbox 有脱敏聚合摘要
    pending = svc.pending()
    assert len(pending) == 1
    assert pending[0].usage is not None
    assert pending[0].usage.run_count == 2
    assert pending[0].usage.error_count == 1

    # 2) ledger 有两条 per-run 明细（按 employee 可聚合）
    agg = svc._ledger.aggregate_by_employee()["e1"]
    assert agg["run_count"] == 2
    assert agg["token_total"] == 25  # (10+5)+(7+3)
    assert agg["error_count"] == 1


def test_record_without_ledger_still_works():
    """ledger=None 时服务仍可用（向后兼容旧装配）。"""
    from agent_service.usage.service import UsageService
    from agent_service.usage.reporter import UsageReporter
    from agent_service.usage.store import InMemoryOutboxRepository
    from agent_service.usage.client import UnconfiguredUsageClient
    from agent_service.usage.models import RawUsageEvent

    svc = UsageService(
        outbox=InMemoryOutboxRepository(),
        reporter=UsageReporter(outbox=InMemoryOutboxRepository(),
                               client=UnconfiguredUsageClient()),
    )
    events = [RawUsageEvent(run_id="r9", usage={"total_tokens": 42})]
    summaries = svc.record_usage("t", events)
    assert summaries and summaries[0].token_total == 42
