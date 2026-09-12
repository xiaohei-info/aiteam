"""Manager usage/work-statistics projections.

The service deliberately reads only retained ``usage_rollup`` aggregates.  It
never reaches into Agent sessions and never treats a prompt/run counter as an
independently identified business-task event.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from shared.contracts.tenancy import TenantContext
from shared.errors import ValidationProblem

from .usage_analytics_schemas import UsageStatisticsOut, UsageWorkHistoryOut

UTC_HOUR = timedelta(hours=1)


def parse_utc_datetime(value: datetime | str, *, field: str) -> datetime:
    """Parse an explicit UTC timestamp without accepting local/naive time."""

    parsed: datetime
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValidationProblem(f"{field} must be a valid UTC ISO-8601 timestamp") from exc
    else:
        raise ValidationProblem(f"{field} must be a UTC ISO-8601 timestamp")
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise ValidationProblem(f"{field} must include UTC timezone")
    return parsed.astimezone(timezone.utc)


def validate_aligned_window(
    window_start: datetime | str | None,
    window_end: datetime | str | None,
) -> tuple[datetime | None, datetime | None]:
    """Validate a paired UTC-hour ``[start, end)`` statistics range."""

    if (window_start is None) != (window_end is None):
        raise ValidationProblem("window_start and window_end must be provided together")
    if window_start is None:
        return None, None
    start = parse_utc_datetime(window_start, field="window_start")
    end = parse_utc_datetime(window_end, field="window_end")
    if (
        start.minute != 0
        or start.second != 0
        or start.microsecond != 0
        or end.minute != 0
        or end.second != 0
        or end.microsecond != 0
        or end <= start
    ):
        raise ValidationProblem(
            "usage statistics require UTC hour-aligned [window_start, window_end) with start < end"
        )
    return start, end


def validate_ingest_window(
    window_start: datetime | str,
    window_end: datetime | str,
    *,
    strict_hour: bool,
) -> tuple[datetime, datetime]:
    """Validate an incoming aggregate's UTC bucket boundaries.

    Current Agent summaries are exactly one hour.  Historical Manager uploads
    may contain older whole-hour windows; those are retained as-is, never split
    into fabricated minute records.  Any current/schema-v1 summary is strict.
    """

    start = parse_utc_datetime(window_start, field="window_start")
    end = parse_utc_datetime(window_end, field="window_end")
    if end <= start:
        raise ValidationProblem("usage window must be a non-empty [window_start, window_end) range")
    if (
        start.minute != 0
        or start.second != 0
        or start.microsecond != 0
        or end.minute != 0
        or end.second != 0
        or end.microsecond != 0
    ):
        raise ValidationProblem("usage windows must be UTC hour-aligned [window_start, window_end)")
    if strict_hour and end - start != UTC_HOUR:
        raise ValidationProblem("Agent usage summaries must represent one UTC hour bucket")
    return start, end


def _validate_identity_filter(value: str | None, *, field: str) -> None:
    if value is not None and (not value.strip() or len(value) > 256):
        raise ValidationProblem(f"{field} must be non-blank and at most 256 characters")


def _decimal(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    try:
        result = value if isinstance(value, Decimal) else Decimal(str(value))
    except (ValueError, TypeError, ArithmeticError) as exc:
        raise ValidationProblem("cost_total must be a non-negative decimal amount") from exc
    if not result.is_finite() or result < 0:
        raise ValidationProblem("cost_total must be a non-negative decimal amount")
    return result


class UsageAnalyticsService:
    """Read-only tenant analytics over retained Manager usage summaries."""

    def __init__(self, repository: Any):
        self._repository = repository

    def statistics(
        self,
        ctx: TenantContext,
        *,
        employee_id: str | None = None,
        member_id: str | None = None,
        window_start: datetime | str | None = None,
        window_end: datetime | str | None = None,
    ) -> UsageStatisticsOut:
        _validate_identity_filter(employee_id, field="employee_id")
        _validate_identity_filter(member_id, field="member_id")
        start, end = validate_aligned_window(window_start, window_end)
        aggregate = self._repository.aggregate_usage_statistics(
            ctx,
            employee_id=employee_id,
            member_id=member_id,
            window_start=start,
            window_end=end,
        )
        summary_count = int(aggregate.get("summary_count", 0))
        unknown_summaries = int(aggregate.get("unknown_summary_count", 0))
        known_summary_count = max(0, summary_count - unknown_summaries)
        known_cost = (
            _decimal(aggregate.get("known_cost_total"))
            if known_summary_count > 0
            else None
        )
        if summary_count == 0 or unknown_summaries >= summary_count:
            pricing_status = "unknown"
        elif unknown_summaries:
            pricing_status = "partial"
        else:
            pricing_status = "known"
        total_cost = None if unknown_summaries or not summary_count else known_cost
        raw_execution_count = aggregate.get("execution_count")
        execution_count = int(
            raw_execution_count
            if raw_execution_count is not None
            else aggregate.get("prompt_count") or aggregate.get("run_count", 0)
        )
        compatibility_run_count = int(aggregate.get("run_count", execution_count))
        token_total = int(aggregate.get("token_total", 0))
        return UsageStatisticsOut(
            employee_id=employee_id,
            member_id=member_id,
            window_start=start,
            window_end=end,
            summary_count=summary_count,
            execution_count=execution_count,
            run_count=compatibility_run_count,
            succeeded_count=int(aggregate.get("settled_count", 0)),
            non_success_count=int(aggregate.get("error_count", 0)),
            input_tokens=int(aggregate.get("input_tokens", 0)),
            output_tokens=int(aggregate.get("output_tokens", 0)),
            cache_tokens=int(aggregate.get("cache_tokens", 0)),
            token_total=token_total,
            total_tokens=token_total,
            token_spending=token_total,
            duration_ms_total=int(aggregate.get("duration_ms_total", 0)),
            duration_seconds_total=int(aggregate.get("duration_seconds_total", 0)),
            cost_total=total_cost,
            total_cost=total_cost,
            total_spending=total_cost,
            known_cost_total=known_cost,
            pricing_status=pricing_status,
            unpriced_execution_count=int(aggregate.get("unknown_pricing_runs", 0)),
            excluded_summary_count=0,
            # No current cross-turn task/event contract exists.  Keep this
            # explicitly unknown rather than relabelling prompt_count/run_count.
            task_count=None,
            task_count_status="unknown",
        )

    def work_history(
        self,
        ctx: TenantContext,
        *,
        employee_id: str | None = None,
        member_id: str | None = None,
        window_start: datetime | str | None = None,
        window_end: datetime | str | None = None,
        limit: int = 500,
    ) -> list[UsageWorkHistoryOut]:
        _validate_identity_filter(employee_id, field="employee_id")
        _validate_identity_filter(member_id, field="member_id")
        start, end = validate_aligned_window(window_start, window_end)
        rows = self._repository.list_usage_history(
            ctx,
            employee_id=employee_id,
            member_id=member_id,
            window_start=start,
            window_end=end,
            limit=limit,
        )
        output: list[UsageWorkHistoryOut] = []
        for row in rows:
            pricing_status = row.get("pricing_status", "unknown")
            raw_cost = row.get("cost_total")
            if pricing_status == "known" and raw_cost is None:
                # Defensive normalization for pre-0042 rows/adapters; a
                # known label without cost evidence is not a zero-cost row.
                pricing_status = "unknown"
            cost = _decimal(raw_cost) if pricing_status == "known" else None
            compatibility_run_count = int(row.get("run_count", 0))
            execution_count = int(row.get("prompt_count") or compatibility_run_count)
            token_total = int(row.get("token_total", 0))
            output.append(
                UsageWorkHistoryOut(
                    rollup_id=str(row["rollup_id"]),
                    summary_id=str(row["summary_id"]),
                    employee_id=row.get("employee_id"),
                    employee_display_name=row.get("employee_display_name"),
                    member_id=row.get("member_id"),
                    member_display_name=row.get("member_display_name"),
                    window_start=parse_utc_datetime(row["window_start"], field="window_start"),
                    window_end=parse_utc_datetime(row["window_end"], field="window_end"),
                    execution_count=execution_count,
                    run_count=compatibility_run_count,
                    token_total=token_total,
                    total_tokens=token_total,
                    token_spending=token_total,
                    cost_total=cost,
                    total_cost=cost,
                    total_spending=cost,
                    known_cost_total=cost if pricing_status == "known" else None,
                    pricing_version=row.get("pricing_version") if pricing_status == "known" else None,
                    pricing_status=pricing_status,
                    error_count=int(row.get("error_count", 0)),
                    duration_seconds_total=int(row.get("duration_seconds_total", 0)),
                    duration_ms_total=int(row.get("duration_ms_total", 0)),
                    task_count=None,
                    task_count_status="unknown",
                    received_at=row.get("received_at"),
                )
            )
        return output


def build_usage_analytics_service(repository: Any) -> UsageAnalyticsService:
    return UsageAnalyticsService(repository)


# A descriptive compatibility alias for callers that use the work-statistics
# name; both names intentionally share the same read-only implementation.
WorkStatisticsService = UsageAnalyticsService
