"""None-safe Manager rollup serialization tests."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

from manager_service.rollup_reporter import RollupReporter
from manager_service.schemas import UsageRollupOut
from shared.contracts.tenancy import TenantContext


CTX = TenantContext(tenant_id="tenant-a", user_id="member-a", roles=["owner"])
START = datetime(2026, 9, 5, 8, tzinfo=timezone.utc)


def _row(summary_id: str, cost: Decimal | None, pricing_status: str):
    return UsageRollupOut(
        rollup_id=f"rollup-{summary_id}", summary_id=summary_id,
        employee_id=None, window_start=START, window_end=START + timedelta(hours=1),
        run_count=1, token_total=10, cost_total=cost,
        pricing_version=1 if pricing_status == "known" else None,
        pricing_status=pricing_status,
    )


def test_rollup_reporter_sums_only_known_costs_in_mixed_batch():
    captured = {}

    class Client:
        def upload(self, payload, *, idempotency_key):
            captured["payload"] = payload
            captured["idempotency_key"] = idempotency_key

    service = SimpleNamespace(list_usage=lambda ctx: [
        _row("known", Decimal("1.250000000001"), "known"),
        _row("unknown", None, "unknown"),
    ])
    result = RollupReporter(service).report(CTX, enterprise_id="enterprise-a", client=Client())

    assert result["cost_total"] == "1.250000000001"
    assert captured["payload"].summaries[0].cost_total == Decimal("1.250000000001")
    assert captured["payload"].summaries[1].cost_total is None
    assert captured["idempotency_key"].startswith("eru_")


def test_rollup_reporter_returns_null_when_every_cost_is_unknown():
    captured = {}

    class Client:
        def upload(self, payload, *, idempotency_key):
            captured["payload"] = payload

    service = SimpleNamespace(list_usage=lambda ctx: [
        _row("unknown-1", None, "unknown"),
        _row("unknown-2", None, "unknown"),
    ])
    result = RollupReporter(service).report(CTX, enterprise_id="enterprise-a", client=Client())

    assert result["cost_total"] is None
    assert all(item.cost_total is None for item in captured["payload"].summaries)
