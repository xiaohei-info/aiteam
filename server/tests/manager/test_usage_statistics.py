"""Manager retained usage statistics, attribution, and delivery contracts."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest

from manager_service.usage_analytics_service import (
    UsageAnalyticsService,
    parse_utc_datetime,
    validate_aligned_window,
)
from manager_service.usage_delivery_repository import (
    DELIVERY_BACKOFF_MAX_SECONDS,
    DELIVERY_BACKOFF_BASE_SECONDS,
    UsageOperatorDeliveryRow,
    delivery_idempotency_key,
    operator_summary_payload,
    retry_delay_seconds,
)
from manager_service.usage_delivery_service import UsageOperatorDeliveryService
from manager_service.usage_audit_quota_service import UsageAuditQuotaService
from shared.contracts.summary import UsageSummary
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden, ValidationProblem
from tests.manager._fake_router import FakeCursor, FakeRouter


CTX = TenantContext(
    tenant_id="11111111-1111-1111-1111-111111111111",
    user_id="22222222-2222-2222-2222-222222222222",
    roles=["owner"],
)
WS = datetime(2026, 9, 5, 8, tzinfo=timezone.utc)
WE = WS + timedelta(hours=2)


class _AnalyticsRepo:
    def __init__(self) -> None:
        self.aggregate_calls: list[dict] = []
        self.history_calls: list[dict] = []

    def aggregate_usage_statistics(self, ctx, **filters):
        assert ctx is CTX
        self.aggregate_calls.append(filters)
        return {
            "summary_count": 3,
            "execution_count": 7,
            "run_count": 6,
            "settled_count": 5,
            "error_count": 2,
            "input_tokens": 10,
            "output_tokens": 20,
            "cache_tokens": 3,
            "token_total": 33,
            "duration_ms_total": 1_234,
            "duration_seconds_total": 2,
            "known_cost_total": Decimal("0.125000000001"),
            "unknown_pricing_tokens": 4,
            "unknown_pricing_runs": 1,
            "unknown_summary_count": 1,
        }

    def list_usage_history(self, ctx, **filters):
        assert ctx is CTX
        self.history_calls.append(filters)
        return [
            {
                "rollup_id": "r1",
                "summary_id": "s1",
                "employee_id": "33333333-3333-3333-3333-333333333333",
                "employee_display_name": "研究员",
                "member_id": "22222222-2222-2222-2222-222222222222",
                "member_display_name": "成员甲",
                "window_start": WS,
                "window_end": WS + timedelta(hours=1),
                "run_count": 2,
                "token_total": 33,
                "cost_total": Decimal("0.125000000001"),
                "pricing_version": 4,
                "pricing_status": "known",
                "error_count": 0,
                "duration_seconds_total": 2,
                "duration_ms_total": 1_234,
                "received_at": WS,
            },
            {
                "rollup_id": "r2",
                "summary_id": "s2",
                "employee_id": None,
                "employee_display_name": "未知员工",
                "member_id": None,
                "member_display_name": "未知成员",
                "window_start": WS + timedelta(hours=1),
                "window_end": WS + timedelta(hours=2),
                "run_count": 1,
                "token_total": 4,
                "cost_total": Decimal("0"),
                "pricing_version": None,
                "pricing_status": "unknown",
                "error_count": 1,
                "duration_seconds_total": 1,
                "duration_ms_total": 0,
                "received_at": WS,
            },
        ]


def test_statistics_uses_retained_hourly_aggregates_and_keeps_unknown_cost_explicit():
    repo = _AnalyticsRepo()
    result = UsageAnalyticsService(repo).statistics(
        CTX,
        employee_id="33333333-3333-3333-3333-333333333333",
        member_id=CTX.user_id,
        window_start=WS,
        window_end=WE,
    )

    assert result.summary_count == 3
    assert result.execution_count == 7
    assert result.run_count == 6
    assert result.token_total == result.token_spending == 33
    assert result.cost_total is None
    assert result.total_spending is None
    assert result.known_cost_total == Decimal("0.125000000001")
    assert result.pricing_status == "partial"
    assert result.unpriced_execution_count == 1
    assert result.task_count is None
    assert result.task_count_status == "unknown"
    assert repo.aggregate_calls == [{
        "employee_id": "33333333-3333-3333-3333-333333333333",
        "member_id": CTX.user_id,
        "window_start": WS,
        "window_end": WE,
    }]


def test_work_history_keeps_known_and_legacy_unknown_attribution_without_session_fields():
    result = UsageAnalyticsService(_AnalyticsRepo()).work_history(
        CTX, window_start=WS, window_end=WE,
    )

    assert result[0].employee_id == "33333333-3333-3333-3333-333333333333"
    assert result[0].member_id == CTX.user_id
    assert result[0].total_spending == Decimal("0.125000000001")
    assert result[1].employee_id is None
    assert result[1].member_id is None
    assert result[1].total_spending is None
    assert result[1].task_count is None
    dumped = result[0].model_dump()
    assert not {"content", "prompt", "entries", "tool_input", "tool_output"} & dumped.keys()


@pytest.mark.parametrize(
    ("start", "end"),
    [
        (WS + timedelta(minutes=1), WE),
        (WS, WE + timedelta(minutes=1)),
        (WS, WS),
        (WS, None),
        (None, WE),
    ],
)
def test_statistics_requires_paired_utc_hour_aligned_window(start, end):
    with pytest.raises(ValidationProblem):
        validate_aligned_window(start, end)


def test_statistics_rejects_naive_window():
    with pytest.raises(ValidationProblem):
        validate_aligned_window(datetime(2026, 9, 5, 8), datetime(2026, 9, 5, 9, tzinfo=timezone.utc))


def test_analytics_rejects_invalid_timestamps_filters_and_costs():
    with pytest.raises(ValidationProblem):
        parse_utc_datetime("not-a-timestamp", field="window_start")
    with pytest.raises(ValidationProblem):
        parse_utc_datetime(42, field="window_start")  # type: ignore[arg-type]
    with pytest.raises(ValidationProblem):
        UsageAnalyticsService(_AnalyticsRepo()).statistics(CTX, employee_id=" ")
    with pytest.raises(ValidationProblem):
        UsageAnalyticsService(_AnalyticsRepo()).statistics(CTX, member_id="x" * 257)

    class InvalidCostRepo(_AnalyticsRepo):
        def aggregate_usage_statistics(self, ctx, **filters):
            result = super().aggregate_usage_statistics(ctx, **filters)
            result.update(summary_count=1, unknown_summary_count=0, known_cost_total="NaN")
            return result

    with pytest.raises(ValidationProblem):
        UsageAnalyticsService(InvalidCostRepo()).statistics(CTX)


def test_analytics_known_and_unknown_branches_preserve_execution_fallback():
    class Repo:
        def aggregate_usage_statistics(self, ctx, **filters):
            return {
                "summary_count": 1, "unknown_summary_count": 0, "known_cost_total": Decimal("0"),
                "execution_count": None, "prompt_count": 3, "run_count": 2,
            }

        def list_usage_history(self, ctx, **filters):
            return [{
                "rollup_id": "r1", "summary_id": "s1", "window_start": WS, "window_end": WE,
                "pricing_status": "known", "cost_total": None, "run_count": 1,
            }]

    stats = UsageAnalyticsService(Repo()).statistics(CTX)
    assert stats.pricing_status == "known"
    assert stats.cost_total == Decimal("0")
    assert stats.execution_count == 3
    history = UsageAnalyticsService(Repo()).work_history(CTX)
    assert history[0].pricing_status == "unknown"
    assert history[0].cost_total is None


def test_billing_overview_uses_nullable_unknown_spending_and_utc_trend_sql():
    from manager_service.billing_repository import BillingRepository

    router = FakeRouter().queue_many(
        FakeCursor(fetchone=(100, Decimal("5"), 20, 2, Decimal("5"), 1, 2, 7, 6)),
        FakeCursor(fetchone=None),
        FakeCursor(fetchall=[]),
        FakeCursor(fetchall=[]),
    )
    data = BillingRepository(router).get_usage_overview(CTX, period="all")
    assert data["total_cost"] is None
    assert data["total_spending"] is None
    assert data["known_cost_total"] == Decimal("5")
    assert data["pricing_status"] == "partial"
    assert "AT TIME ZONE 'UTC'" in router.executed[2][0]


def test_known_pricing_with_omitted_cost_normalizes_to_unknown_null():
    captured = {}

    class Repo:
        def employee_exists(self, ctx, *, employee_id):
            return True

        def employee_granted_to_member(self, ctx, *, employee_id, member_id):
            return True

        def upsert_usage(self, ctx, *, payload):
            captured.update(payload)
            return SimpleNamespace()

        def upsert_audit(self, ctx, *, payload):
            return SimpleNamespace()

    UsageAuditQuotaService(Repo()).ingest_upload(CTX, {"usage": [{
        "schema_version": "1", "summary_id": "known-omitted",
        "member_id": CTX.user_id, "employee_id": "33333333-3333-3333-3333-333333333333",
        "window_start": "2026-09-05T08:00:00Z", "window_end": "2026-09-05T09:00:00Z",
        "run_count": 1, "token_total": 2, "pricing_status": "known", "pricing_version": 1,
        "currency": "USD", "error_count": 0, "duration_seconds_total": 1,
    }], "audits": []})
    assert captured["pricing_status"] == "unknown"
    assert captured["pricing_version"] is None
    assert captured["cost_total"] is None


def test_known_pricing_with_explicit_null_cost_normalizes_to_unknown_null():
    captured = {}

    class Repo:
        def employee_exists(self, ctx, *, employee_id):
            return True

        def employee_granted_to_member(self, ctx, *, employee_id, member_id):
            return True

        def upsert_usage(self, ctx, *, payload):
            captured.update(payload)
            return SimpleNamespace()

        def upsert_audit(self, ctx, *, payload):
            return SimpleNamespace()

    UsageAuditQuotaService(Repo()).ingest_upload(CTX, {"usage": [{
        "schema_version": "1", "summary_id": "known-null",
        "member_id": CTX.user_id, "employee_id": "33333333-3333-3333-3333-333333333333",
        "window_start": "2026-09-05T08:00:00Z", "window_end": "2026-09-05T09:00:00Z",
        "run_count": 1, "token_total": 2, "cost_total": None,
        "pricing_status": "known", "pricing_version": 1, "currency": "USD",
        "error_count": 0, "duration_seconds_total": 1,
    }], "audits": []})
    assert captured["pricing_status"] == "unknown"
    assert captured["pricing_version"] is None
    assert captured["cost_total"] is None


def test_explicit_unknown_pricing_is_stored_with_nullable_cost():
    captured = {}

    class Repo:
        def employee_exists(self, ctx, *, employee_id):
            return True

        def employee_granted_to_member(self, ctx, *, employee_id, member_id):
            return True

        def upsert_usage(self, ctx, *, payload):
            captured.update(payload)
            return SimpleNamespace()

        def upsert_audit(self, ctx, *, payload):
            return SimpleNamespace()

    service = UsageAuditQuotaService(Repo())
    service.ingest_upload(CTX, {"usage": [{
        "schema_version": "1",
        "summary_id": "unknown-cost",
        "member_id": CTX.user_id,
        "employee_id": "33333333-3333-3333-3333-333333333333",
        "window_start": "2026-09-05T08:00:00Z",
        "window_end": "2026-09-05T09:00:00Z",
        "run_count": 1,
        "token_total": 2,
        "cost_total": 0,
        "pricing_status": "unknown",
        "currency": "USD",
        "error_count": 0,
        "duration_seconds_total": 1,
    }], "audits": []})
    assert captured["cost_total"] is None


def test_usage_payload_rejects_spoofed_member_attribution():
    service = UsageAuditQuotaService(SimpleNamespace())
    with pytest.raises(Forbidden):
        service._usage_payload({
            "summary_id": "spoofed",
            "member_id": "99999999-9999-9999-9999-999999999999",
            "employee_id": None,
            "window_start": "2026-09-05T08:00:00Z",
            "window_end": "2026-09-05T09:00:00Z",
        }, ctx=CTX)


def test_legacy_usage_payload_does_not_infer_current_member_attribution():
    class Repo:
        def upsert_usage(self, ctx, *, payload):
            assert payload["member_id"] is None
            assert payload["employee_id"] is None
            assert payload["pricing_status"] == "unknown"
            assert payload["pricing_version"] is None
            assert payload["cost_total"] is None
            return SimpleNamespace()

        def upsert_audit(self, ctx, *, payload):
            return SimpleNamespace()

    service = UsageAuditQuotaService(Repo())
    item = {
        "summary_id": "legacy",
        "window_start": "2026-09-05T08:00:00Z",
        "window_end": "2026-09-05T09:00:00Z",
        "run_count": 1,
        "token_total": 4,
        "cost_total": "0.01",
        "error_count": 0,
        "duration_seconds_total": 1,
    }
    assert service.ingest_upload(CTX, {"usage": [item], "audits": []}) == {
        "usage_ingested": 1,
        "audits_ingested": 0,
    }


class _DeliveryRepo:
    def __init__(self, row):
        self.row = row
        self.assigned: list[str] = []
        self.failed: list[dict] = []
        self.sent: list[dict] = []

    def assign_enterprise_id(self, ctx, *, enterprise_id):
        self.assigned.append(enterprise_id)
        return 1

    def claim_due(self, ctx, *, limit):
        return [self.row]

    def mark_failed(self, ctx, **values):
        self.failed.append(values)
        return True

    def mark_sent(self, ctx, **values):
        self.sent.append(values)
        return True


class _FailingClient:
    def __init__(self):
        self.payloads = []

    def upload(self, payload, *, idempotency_key):
        self.payloads.append((payload, idempotency_key))
        raise RuntimeError("Operator unavailable")


def _delivery_row():
    return UsageOperatorDeliveryRow(
        delivery_id="44444444-4444-4444-4444-444444444444",
        tenant_id=CTX.tenant_id,
        enterprise_id="55555555-5555-5555-5555-555555555555",
        summary_id="summary-1",
        idempotency_key="usage-stable",
        payload={
            "summary_id": "summary-1",
            "tenant_id": CTX.tenant_id,
            "employee_id": None,
            "window_start": WS.isoformat(),
            "window_end": (WS + timedelta(hours=1)).isoformat(),
            "run_count": 1,
            "token_total": 3,
            "cost_total": "0.000000000001",
            "currency": "USD",
            "pricing_version": 1,
            "pricing_status": "known",
            "error_count": 0,
            "duration_seconds_total": 1,
        },
        status="pending",
        attempts=1,
        next_attempt_at=WS,
        last_error=None,
        claim_token="claim-1",
        claimed_at=WS,
        created_at=WS,
        updated_at=WS,
        sent_at=None,
    )


def test_delivery_worker_uses_signed_contract_shape_and_bounded_failure_backoff():
    repo = _DeliveryRepo(_delivery_row())
    client = _FailingClient()
    service = UsageOperatorDeliveryService(repo, client)
    result = service.deliver_due(CTX)

    assert result == {"claimed": 1, "sent": 0, "failed": 1, "deferred": 0}
    assert repo.failed[0]["attempts"] == 1
    assert len(client.payloads) == 1
    payload, key = client.payloads[0]
    assert payload.tenant_id == CTX.tenant_id
    assert not hasattr(payload.summaries[0], "member_id")
    assert key == "usage-stable"
    assert retry_delay_seconds(1) == DELIVERY_BACKOFF_BASE_SECONDS
    assert retry_delay_seconds(100) == DELIVERY_BACKOFF_MAX_SECONDS


def test_delivery_worker_sends_successfully_and_handles_mapping_or_claim_failures():
    class SuccessClient:
        def __init__(self):
            self.payloads = []
            self.closed = False

        def upload(self, payload, *, idempotency_key):
            self.payloads.append((payload, idempotency_key))

        def close(self):
            self.closed = True

    client = SuccessClient()
    repo = _DeliveryRepo(_delivery_row())
    service = UsageOperatorDeliveryService(repo, client, enterprise_resolver=lambda _: "resolved-enterprise")
    assert service.deliver_due(CTX) == {"claimed": 1, "sent": 1, "failed": 0, "deferred": 0}
    assert repo.assigned == ["resolved-enterprise"]
    assert repo.sent[0]["claim_token"] == "claim-1"
    service.close()
    assert client.closed

    class MappingFailureRepo(_DeliveryRepo):
        def assign_enterprise_id(self, ctx, *, enterprise_id):
            raise RuntimeError("mapping write unavailable")

    deferred = UsageOperatorDeliveryService(
        MappingFailureRepo(_delivery_row()), SuccessClient(), enterprise_resolver=lambda _: "resolved-enterprise",
    )
    assert deferred.deliver_due(CTX) == {"claimed": 0, "sent": 0, "failed": 0, "deferred": 1}

    class ClaimFailureRepo(_DeliveryRepo):
        def claim_due(self, ctx, *, limit):
            raise RuntimeError("claim unavailable")

    skipped = UsageOperatorDeliveryService(ClaimFailureRepo(_delivery_row()), SuccessClient())
    assert skipped.deliver_due(CTX) == {"claimed": 0, "sent": 0, "failed": 0, "deferred": 1}

    resolver_failed = UsageOperatorDeliveryService(
        _DeliveryRepo(_delivery_row()), SuccessClient(), enterprise_resolver=lambda _: (_ for _ in ()).throw(RuntimeError("mapping unavailable")),
    )
    assert resolver_failed.deliver_due(CTX)["sent"] == 1


def test_delivery_payload_rejects_wrong_tenant_or_missing_enterprise():
    row = _delivery_row()
    with pytest.raises(ValueError, match="tenant attribution"):
        UsageOperatorDeliveryService._operator_payload(
            replace(row, payload={**row.payload, "tenant_id": "other-tenant"}),
        )
    with pytest.raises(ValueError, match="enterprise mapping"):
        UsageOperatorDeliveryService._operator_payload(replace(row, enterprise_id=None))


@pytest.mark.asyncio
async def test_usage_delivery_lifespan_runs_one_bounded_tenant_sweep_and_closes(monkeypatch):
    from fastapi import FastAPI
    from manager_service import usage_delivery_service as delivery_module

    app = FastAPI()
    app.state.settings = SimpleNamespace(
        db_url="postgresql://app", admin_db_url="postgresql://admin", operator_url="https://operator",
    )
    called = asyncio.Event()
    loop = asyncio.get_running_loop()

    class Service:
        def __init__(self):
            self.contexts = []
            self.closed = False

        def deliver_due(self, ctx, *, limit):
            self.contexts.append((ctx, limit))
            loop.call_soon_threadsafe(called.set)

        def close(self):
            self.closed = True

    service = Service()
    monkeypatch.setattr(delivery_module, "build_usage_operator_delivery_service", lambda settings: service)
    monkeypatch.setattr(delivery_module, "_list_manager_tenants", lambda admin, after=None: ["tenant-1"])
    monkeypatch.setattr(delivery_module, "DELIVERY_POLL_SECONDS", 0.01)
    delivery_module.install_usage_delivery_lifespan(app)

    async def exercise():
        async with app.router.lifespan_context(app):
            await asyncio.wait_for(called.wait(), timeout=2)

    await exercise()
    assert service.contexts[0][0].tenant_id == "tenant-1"
    assert service.closed


def test_shared_operator_summary_contract_accepts_unknown_nullable_cost():
    summary = UsageSummary(
        summary_id="unknown-cost",
        tenant_id=CTX.tenant_id,
        window_start=WS,
        window_end=WS + timedelta(hours=1),
        pricing_status="unknown",
        cost_total=None,
    )
    assert summary.pricing_status == "unknown"
    assert summary.cost_total is None


def test_unknown_pricing_serializes_nullable_delivery_cost_not_zero():
    payload = operator_summary_payload({
        "summary_id": "unknown-cost",
        "tenant_id": CTX.tenant_id,
        "employee_id": None,
        "window_start": WS,
        "window_end": WS + timedelta(hours=1),
        "run_count": 1,
        "token_total": 2,
        "cost_total": Decimal("0"),
        "pricing_version": None,
        "pricing_status": "unknown",
        "currency": "USD",
        "error_count": 0,
        "duration_seconds_total": 1,
    }, tenant_id=CTX.tenant_id)
    assert payload["pricing_status"] == "unknown"
    assert payload["cost_total"] is None


def test_delivery_idempotency_key_changes_only_for_exact_summary_revision():
    summary = _delivery_row().payload
    first = delivery_idempotency_key(
        tenant_id=CTX.tenant_id,
        enterprise_id="55555555-5555-5555-5555-555555555555",
        summary_payload=summary,
    )
    assert first == delivery_idempotency_key(
        tenant_id=CTX.tenant_id,
        enterprise_id="55555555-5555-5555-5555-555555555555",
        summary_payload=dict(summary),
    )
    changed = dict(summary, token_total=4)
    assert first != delivery_idempotency_key(
        tenant_id=CTX.tenant_id,
        enterprise_id="55555555-5555-5555-5555-555555555555",
        summary_payload=changed,
    )
