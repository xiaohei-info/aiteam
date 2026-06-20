"""A5 验收：脱敏聚合正确性 + 脱敏护栏（04 §6.5 / D13）。

覆盖：按 (employee, 窗口) 聚合正确、token/cost 归一、error/duration 累计、幂等 summary_id 稳定、
审计摘要脱敏、聚合产物 schema 与契约一致（只 import 契约，禁重定义）。
"""

from datetime import datetime, timezone
from decimal import Decimal

from agent_service.usage.aggregator import UsageAggregator
from agent_service.usage.models import RawAuditEvent, RawUsageEvent
from shared.contracts.summary import AuditSummaryEvent, UsageSummary


def _ts(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 6, 18, hour, minute, 0, tzinfo=timezone.utc)


def test_aggregate_usage_groups_by_employee_and_window():
    agg = UsageAggregator()
    events = [
        RawUsageEvent(run_id="r1", employee_id="e1",
                      usage={"input_tokens": 10, "output_tokens": 5, "cost": "0.10"},
                      duration_seconds=3, occurred_at=_ts(10, 5)),
        RawUsageEvent(run_id="r2", employee_id="e1",
                      usage={"total_tokens": 20, "cost": "0.20"},
                      duration_seconds=7, error=True, occurred_at=_ts(10, 50)),
        RawUsageEvent(run_id="r3", employee_id="e2",
                      usage={"input_tokens": 1, "output_tokens": 1},
                      occurred_at=_ts(10, 30)),
    ]
    summaries = agg.aggregate_usage("t1", events)

    assert all(isinstance(s, UsageSummary) for s in summaries)
    by_emp = {s.employee_id: s for s in summaries}
    assert by_emp["e1"].run_count == 2
    assert by_emp["e1"].token_total == 35  # (10+5) + 20
    assert by_emp["e1"].cost_total == Decimal("0.30")
    assert by_emp["e1"].error_count == 1
    assert by_emp["e1"].duration_seconds_total == 10
    assert by_emp["e2"].token_total == 2
    assert by_emp["e2"].cost_total == Decimal("0")


def test_summary_id_is_idempotent_for_same_domain():
    """同一 (tenant, employee, 窗口) 反复聚合得到同一 summary_id。"""
    agg = UsageAggregator()
    e = [RawUsageEvent(run_id="r1", employee_id="e1", usage={"total_tokens": 5},
                       occurred_at=_ts(10, 1))]
    first = agg.aggregate_usage("t1", e)[0].summary_id
    e2 = [RawUsageEvent(run_id="rX", employee_id="e1", usage={"total_tokens": 99},
                        occurred_at=_ts(10, 59))]  # 同窗口、不同内容
    second = agg.aggregate_usage("t1", e2)[0].summary_id
    assert first == second  # 幂等键只取决于聚合域，不取决于内容


def test_different_window_yields_different_summary_id():
    agg = UsageAggregator()
    a = agg.aggregate_usage("t1", [RawUsageEvent(run_id="r", employee_id="e1",
                                                 usage={}, occurred_at=_ts(10))])[0]
    b = agg.aggregate_usage("t1", [RawUsageEvent(run_id="r", employee_id="e1",
                                                 usage={}, occurred_at=_ts(11))])[0]
    assert a.summary_id != b.summary_id


def test_token_fallback_and_decimal_cost():
    """缺 total_tokens 时回退 input+output；cost 用 Decimal 不丢精度。"""
    agg = UsageAggregator()
    s = agg.aggregate_usage("t1", [
        RawUsageEvent(run_id="r1", employee_id="e1",
                      usage={"prompt_tokens": 100, "completion_tokens": 23,
                             "cost": "0.000123"}, occurred_at=_ts(9)),
    ])[0]
    assert s.token_total == 123
    assert s.cost_total == Decimal("0.000123")


def test_aggregate_audits_is_sanitized_skeleton():
    agg = UsageAggregator()
    audits = agg.aggregate_audits("t1", [
        RawAuditEvent(actor="u1", action="expert_load", resource_type="employee",
                      resource_id="emp1", occurred_at=_ts(8)),
    ])
    assert len(audits) == 1
    a = audits[0]
    assert isinstance(a, AuditSummaryEvent)
    assert a.actor == "u1" and a.action == "expert_load"
    assert a.resource_id == "emp1"
    assert a.summary_id.startswith("audt_")
