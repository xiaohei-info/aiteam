"""Durable Manager -> Operator usage delivery receipts.

The Manager usage table is the aggregate ledger.  This repository owns only the
metadata needed to deliver those aggregates to Operator reliably: a sanitized
summary payload, its deterministic idempotency key, and a bounded retry claim.
It never stores conversation entries, prompts, tool input/output, or raw runtime
 events.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

from shared.errors import Conflict
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter

# Keep retries finite.  The final failed receipt is retained for operator review
# or an explicitly initiated replay; it is never silently discarded.
MAX_DELIVERY_ATTEMPTS = 8
DELIVERY_BACKOFF_BASE_SECONDS = 5
DELIVERY_BACKOFF_MAX_SECONDS = 300
DELIVERY_CLAIM_LEASE_SECONDS = 300


@dataclass(frozen=True)
class UsageOperatorDeliveryRow:
    """One aggregate delivery receipt, scoped to one Manager tenant."""

    delivery_id: str
    tenant_id: str
    enterprise_id: str | None
    summary_id: str
    idempotency_key: str
    payload: dict[str, Any]
    status: str
    attempts: int
    next_attempt_at: datetime | None
    last_error: str | None
    claim_token: str | None
    claimed_at: datetime | None
    created_at: datetime
    updated_at: datetime
    sent_at: datetime | None
    member_id: str | None = None
    employee_id: str | None = None


_DELIVERY_COLUMNS = (
    "id, tenant_id, enterprise_id, summary_id, idempotency_key, payload, status, attempts, "
    "next_attempt_at, last_error, claim_token, claimed_at, created_at, updated_at, sent_at, "
    "member_id, employee_id"
)


def _to_uuid(value: str | UUID | None) -> UUID | None:
    if value is None or value == "":
        return None
    if isinstance(value, UUID):
        return value
    return UUID(str(value))


def _payload_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except (TypeError, ValueError):
            decoded = None
        if isinstance(decoded, dict):
            return decoded
    return {}


def _row_to_delivery(row: Any) -> UsageOperatorDeliveryRow:
    return UsageOperatorDeliveryRow(
        delivery_id=str(row[0]),
        tenant_id=str(row[1]),
        enterprise_id=str(row[2]) if row[2] is not None else None,
        summary_id=str(row[3]),
        idempotency_key=str(row[4]),
        payload=_payload_dict(row[5]),
        status=str(row[6]),
        attempts=int(row[7] or 0),
        next_attempt_at=row[8],
        last_error=row[9],
        claim_token=str(row[10]) if row[10] is not None else None,
        claimed_at=row[11],
        created_at=row[12],
        updated_at=row[13],
        sent_at=row[14],
        member_id=str(row[15]) if len(row) > 15 and row[15] is not None else None,
        employee_id=str(row[16]) if len(row) > 16 and row[16] is not None else None,
    )


class NullableUsageSummaryPayload(BaseModel):
    """Manager's nullable serializer at the existing Operator seam.

    The repository's shared UsageSummary currently predates nullable unknown
    pricing.  This internal model preserves ``None`` for unknown cost instead
    of canonically storing/sending numeric zero; parent integration must update
    the shared contract and Operator consumer to accept it.
    """

    model_config = ConfigDict(extra="forbid")

    summary_id: str
    tenant_id: str
    employee_id: str | None = None
    window_start: datetime
    window_end: datetime
    run_count: int = Field(ge=0, default=0)
    token_total: int = Field(ge=0, default=0)
    cost_total: Decimal | None = None
    pricing_version: int | None = Field(default=None, ge=1)
    pricing_status: Literal["known", "unknown"] = "unknown"
    currency: Literal["USD"] = "USD"
    error_count: int = Field(ge=0, default=0)
    duration_seconds_total: int = Field(ge=0, default=0)

    @model_validator(mode="before")
    @classmethod
    def normalize_pricing_cost(cls, value):
        if not isinstance(value, dict):
            return value
        normalized = dict(value)
        pricing_status = normalized.get("pricing_status", "unknown")
        if pricing_status == "known" and normalized.get("cost_total") is None:
            normalized["pricing_status"] = "unknown"
            normalized["pricing_version"] = None
        elif pricing_status == "unknown":
            normalized["cost_total"] = None
            normalized["pricing_version"] = None
        return normalized


class NullableEnterpriseRollupUpload(BaseModel):
    """Existing Manager -> Operator envelope with nullable cost semantics."""

    model_config = ConfigDict(extra="forbid")

    enterprise_id: str
    tenant_id: str
    summaries: list[NullableUsageSummaryPayload] = Field(default_factory=list)


def operator_summary_payload(payload: dict[str, Any], *, tenant_id: str) -> dict[str, Any]:
    """Project an Agent/Manager item onto a safe nullable Operator payload.

    Agent sends richer local-only counters and member attribution.  Only the
    existing aggregate fields cross the signed ServiceClient boundary.  Unknown
    pricing deliberately serializes ``cost_total`` as null; it is never changed
    into canonical numeric zero here.
    """

    pricing_status = payload.get("pricing_status", "unknown")
    cost_total = None if pricing_status == "unknown" else payload.get("cost_total")
    summary = NullableUsageSummaryPayload(
        summary_id=str(payload["summary_id"]),
        tenant_id=tenant_id,
        employee_id=payload.get("employee_id"),
        window_start=payload["window_start"],
        window_end=payload["window_end"],
        run_count=int(payload.get("run_count", 0)),
        token_total=int(payload.get("token_total", 0)),
        cost_total=cost_total,
        pricing_version=payload.get("pricing_version"),
        pricing_status=pricing_status,
        currency=payload.get("currency", "USD"),
        error_count=int(payload.get("error_count", 0)),
        duration_seconds_total=int(payload.get("duration_seconds_total", 0)),
    )
    return summary.model_dump(mode="json")


def delivery_idempotency_key(
    *, tenant_id: str, enterprise_id: str | None, summary_payload: dict[str, Any]
) -> str:
    """Derive a stable key for one exact summary revision.

    A repeated request with the same summary contents gets the same key.  An
    updated cumulative hourly summary gets a different key while retaining the
    same ``summary_id``, allowing Operator to update its idempotent seen row.
    """

    canonical = json.dumps(summary_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    digest = hashlib.sha256(
        f"{tenant_id}|{enterprise_id or ''}|{canonical}".encode("utf-8")
    ).hexdigest()[:32]
    return f"usage_{digest}"


def retry_delay_seconds(attempts: int) -> int:
    """Return bounded exponential backoff after a claimed attempt."""

    exponent = max(0, min(int(attempts) - 1, 30))
    return min(DELIVERY_BACKOFF_MAX_SECONDS, DELIVERY_BACKOFF_BASE_SECONDS * (2**exponent))


class UsageOperatorDeliveryRepository:
    """Tenant-scoped durable outbox for Manager -> Operator usage summaries."""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def enqueue(
        self,
        ctx: TenantContext,
        *,
        summary_payload: dict[str, Any],
        enterprise_id: str | None = None,
    ) -> UsageOperatorDeliveryRow:
        """Persist or refresh one summary delivery receipt.

        This method is useful for callers outside the usage ingest transaction.
        ``UsageAuditQuotaRepository.upsert_usage_with_delivery`` uses the same
        SQL helper in its transaction to avoid a rollup/outbox split-brain.
        """

        with self._router.session(ctx) as session:
            return self.enqueue_in_session(
                session,
                ctx,
                summary_payload=summary_payload,
                enterprise_id=enterprise_id,
            )

    @staticmethod
    def enqueue_in_session(
        session: Any,
        ctx: TenantContext,
        *,
        summary_payload: dict[str, Any],
        enterprise_id: str | None = None,
    ) -> UsageOperatorDeliveryRow:
        """Insert/update a receipt using an already-open TenantDataSession."""

        sanitized = operator_summary_payload(summary_payload, tenant_id=ctx.tenant_id)
        enterprise_uuid = _to_uuid(enterprise_id)
        idempotency_key = delivery_idempotency_key(
            tenant_id=ctx.tenant_id,
            enterprise_id=enterprise_id,
            summary_payload=sanitized,
        )
        row = session.execute(
            """
            INSERT INTO usage_operator_delivery (
                tenant_id, enterprise_id, summary_id, idempotency_key, payload,
                status, attempts, next_attempt_at, member_id, employee_id
            ) VALUES (%s, %s, %s, %s, %s::jsonb, 'pending', 0, now(), %s, %s)
            ON CONFLICT (tenant_id, summary_id) DO UPDATE SET
                enterprise_id = COALESCE(EXCLUDED.enterprise_id, usage_operator_delivery.enterprise_id),
                member_id = CASE
                    WHEN EXCLUDED.member_id IS NULL THEN usage_operator_delivery.member_id
                    ELSE EXCLUDED.member_id
                END,
                employee_id = CASE
                    WHEN EXCLUDED.employee_id IS NULL THEN usage_operator_delivery.employee_id
                    ELSE EXCLUDED.employee_id
                END,
                idempotency_key = CASE
                    WHEN usage_operator_delivery.payload IS DISTINCT FROM EXCLUDED.payload
                        THEN EXCLUDED.idempotency_key
                    ELSE usage_operator_delivery.idempotency_key
                END,
                payload = EXCLUDED.payload,
                status = CASE
                    WHEN usage_operator_delivery.payload IS DISTINCT FROM EXCLUDED.payload
                        THEN 'pending'
                    ELSE usage_operator_delivery.status
                END,
                attempts = CASE
                    WHEN usage_operator_delivery.payload IS DISTINCT FROM EXCLUDED.payload
                        THEN 0
                    ELSE usage_operator_delivery.attempts
                END,
                next_attempt_at = CASE
                    WHEN usage_operator_delivery.payload IS DISTINCT FROM EXCLUDED.payload
                        THEN now()
                    ELSE usage_operator_delivery.next_attempt_at
                END,
                last_error = CASE
                    WHEN usage_operator_delivery.payload IS DISTINCT FROM EXCLUDED.payload
                        THEN NULL
                    ELSE usage_operator_delivery.last_error
                END,
                claim_token = CASE
                    WHEN usage_operator_delivery.payload IS DISTINCT FROM EXCLUDED.payload
                        THEN NULL
                    ELSE usage_operator_delivery.claim_token
                END,
                claimed_at = CASE
                    WHEN usage_operator_delivery.payload IS DISTINCT FROM EXCLUDED.payload
                        THEN NULL
                    ELSE usage_operator_delivery.claimed_at
                END,
                sent_at = CASE
                    WHEN usage_operator_delivery.payload IS DISTINCT FROM EXCLUDED.payload
                        THEN NULL
                    ELSE usage_operator_delivery.sent_at
                END,
                updated_at = now()
            WHERE (
                EXCLUDED.employee_id IS NULL
                OR usage_operator_delivery.employee_id = EXCLUDED.employee_id
            ) AND (
                EXCLUDED.member_id IS NULL
                OR usage_operator_delivery.member_id = EXCLUDED.member_id
            )
            RETURNING """ + _DELIVERY_COLUMNS,
            (
                _to_uuid(ctx.tenant_id),
                enterprise_uuid,
                sanitized["summary_id"],
                idempotency_key,
                json.dumps(sanitized, sort_keys=True, separators=(",", ":")),
                _to_uuid(summary_payload.get("member_id")),
                _to_uuid(summary_payload.get("employee_id")),
            ),
        ).fetchone()
        if row is None:
            raise Conflict("usage delivery attribution is immutable once assigned")
        return _row_to_delivery(row)

    def assign_enterprise_id(self, ctx: TenantContext, *, enterprise_id: str) -> int:
        """Attach a now-known Operator enterprise id to unresolved receipts.

        Legacy/unmapped receipts remain durable until this succeeds.  Sending
        claims are left untouched so a worker cannot rewrite a payload currently
        being delivered by another worker.
        """

        enterprise_uuid = _to_uuid(enterprise_id)
        changed = 0
        with self._router.session(ctx) as session:
            rows = session.execute(
                "SELECT id, summary_id, payload FROM usage_operator_delivery "
                "WHERE status <> 'sent' AND status <> 'sending' "
                "AND enterprise_id IS DISTINCT FROM %s ORDER BY created_at FOR UPDATE",
                (enterprise_uuid,),
            ).fetchall()
            for row in rows:
                payload = _payload_dict(row[2])
                key = delivery_idempotency_key(
                    tenant_id=ctx.tenant_id,
                    enterprise_id=enterprise_id,
                    summary_payload=payload,
                )
                updated = session.execute(
                    "UPDATE usage_operator_delivery SET enterprise_id = %s, idempotency_key = %s, "
                    "updated_at = now() WHERE id = %s AND status <> 'sent' AND status <> 'sending'",
                    (enterprise_uuid, key, row[0]),
                )
                changed += int(getattr(updated, "rowcount", 0) or 0)
        return changed

    def get(self, ctx: TenantContext, *, delivery_id: str) -> UsageOperatorDeliveryRow | None:
        with self._router.session(ctx) as session:
            row = session.execute(
                "SELECT " + _DELIVERY_COLUMNS + " FROM usage_operator_delivery WHERE id = %s",
                (_to_uuid(delivery_id),),
            ).fetchone()
        return _row_to_delivery(row) if row is not None else None

    def list(
        self,
        ctx: TenantContext,
        *,
        statuses: tuple[str, ...] | None = None,
        limit: int = 200,
    ) -> list[UsageOperatorDeliveryRow]:
        """List durable receipts without deleting sent history."""

        safe_limit = max(1, min(int(limit), 500))
        with self._router.session(ctx) as session:
            if statuses:
                rows = session.execute(
                    "SELECT " + _DELIVERY_COLUMNS + " FROM usage_operator_delivery "
                    "WHERE status = ANY(%s) ORDER BY created_at DESC, id DESC LIMIT %s",
                    (list(statuses), safe_limit),
                ).fetchall()
            else:
                rows = session.execute(
                    "SELECT " + _DELIVERY_COLUMNS + " FROM usage_operator_delivery "
                    "ORDER BY created_at DESC, id DESC LIMIT %s",
                    (safe_limit,),
                ).fetchall()
        return [_row_to_delivery(row) for row in rows]

    def claim_due(
        self,
        ctx: TenantContext,
        *,
        limit: int = 8,
        now: datetime | None = None,
    ) -> list[UsageOperatorDeliveryRow]:
        """Claim due/unsettled receipts with row locks and a bounded lease."""

        del now  # PostgreSQL clock is authoritative for concurrent workers.
        safe_limit = max(1, min(int(limit), 32))
        claim_token = str(uuid4())
        with self._router.session(ctx) as session:
            rows = session.execute(
                """
                WITH expired AS (
                    UPDATE usage_operator_delivery
                    SET status = 'failed',
                        last_error = COALESCE(last_error, 'usage delivery claim lease expired after retry bound'),
                        next_attempt_at = NULL,
                        claim_token = NULL,
                        claimed_at = NULL,
                        updated_at = now()
                    WHERE status = 'sending'
                      AND attempts >= %s
                      AND claimed_at IS NOT NULL
                      AND claimed_at < now() - (%s * interval '1 second')
                    RETURNING id
                ), due AS (
                    SELECT id
                    FROM usage_operator_delivery
                    WHERE enterprise_id IS NOT NULL
                      AND attempts < %s
                      AND (
                          (status IN ('pending', 'failed') AND next_attempt_at <= now())
                          OR (
                              status = 'sending'
                              AND claimed_at IS NOT NULL
                              AND claimed_at < now() - (%s * interval '1 second')
                          )
                      )
                    ORDER BY next_attempt_at, created_at, id
                    FOR UPDATE SKIP LOCKED
                    LIMIT %s
                )
                UPDATE usage_operator_delivery AS delivery
                SET status = 'sending', attempts = delivery.attempts + 1,
                    claim_token = %s, claimed_at = now(), updated_at = now()
                FROM due
                WHERE delivery.id = due.id
                RETURNING """ + _DELIVERY_COLUMNS,
                (
                    MAX_DELIVERY_ATTEMPTS,
                    DELIVERY_CLAIM_LEASE_SECONDS,
                    MAX_DELIVERY_ATTEMPTS,
                    DELIVERY_CLAIM_LEASE_SECONDS,
                    safe_limit,
                    claim_token,
                ),
            ).fetchall()
        return [_row_to_delivery(row) for row in rows]

    def mark_sent(self, ctx: TenantContext, *, delivery_id: str, claim_token: str) -> bool:
        with self._router.session(ctx) as session:
            row = session.execute(
                "UPDATE usage_operator_delivery SET status = 'sent', sent_at = now(), "
                "next_attempt_at = NULL, last_error = NULL, claim_token = NULL, claimed_at = NULL, "
                "updated_at = now() WHERE id = %s AND status = 'sending' AND claim_token = %s "
                "RETURNING id",
                (_to_uuid(delivery_id), claim_token),
            ).fetchone()
        return row is not None

    def mark_failed(
        self,
        ctx: TenantContext,
        *,
        delivery_id: str,
        claim_token: str,
        error: str,
        attempts: int,
    ) -> bool:
        """Record safe error metadata and schedule bounded retry/backoff."""

        safe_error = " ".join(str(error).split())[:512] or "Operator usage delivery failed"
        delay = retry_delay_seconds(attempts)
        with self._router.session(ctx) as session:
            row = session.execute(
                """
                UPDATE usage_operator_delivery
                SET status = 'failed',
                    last_error = %s,
                    next_attempt_at = CASE WHEN attempts >= %s THEN NULL
                                           ELSE now() + (%s * interval '1 second') END,
                    claim_token = NULL,
                    claimed_at = NULL,
                    updated_at = now()
                WHERE id = %s AND status = 'sending' AND claim_token = %s
                RETURNING id
                """,
                (
                    safe_error,
                    MAX_DELIVERY_ATTEMPTS,
                    delay,
                    _to_uuid(delivery_id),
                    claim_token,
                ),
            ).fetchone()
        return row is not None

    # Explicitly named aliases keep the outbox seam discoverable to maintenance
    # jobs without creating a second repository or ledger.
    def enqueue_usage_delivery(self, ctx: TenantContext, *, summary_payload: dict[str, Any], enterprise_id: str | None = None) -> UsageOperatorDeliveryRow:
        return self.enqueue(ctx, summary_payload=summary_payload, enterprise_id=enterprise_id)

    def list_deliveries(
        self,
        ctx: TenantContext,
        *,
        statuses: tuple[str, ...] | None = None,
        limit: int = 200,
    ) -> list[UsageOperatorDeliveryRow]:
        return self.list(ctx, statuses=statuses, limit=limit)

    def pending_count(self, ctx: TenantContext) -> int:
        with self._router.session(ctx) as session:
            row = session.execute(
                "SELECT COUNT(*) FROM usage_operator_delivery "
                "WHERE status IN ('pending', 'sending', 'failed')",
            ).fetchone()
        return int(row[0] or 0)


def build_usage_operator_delivery_repository(router: PgTenantRouter) -> UsageOperatorDeliveryRepository:
    return UsageOperatorDeliveryRepository(router)
