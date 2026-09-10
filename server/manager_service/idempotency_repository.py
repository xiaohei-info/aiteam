"""Durable Manager-side idempotency receipts for control-plane writes.

The receipt is deliberately tenant scoped and stores only a request fingerprint and
safe response envelope.  It never stores the F02 bootstrap secret, notification
request body, or any other sensitive request material.  The caller supplies a
transaction callback so the receipt and the tenant mutation commit atomically.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Callable

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict, ValidationProblem

_MAX_KEY_LENGTH = 256


@dataclass(frozen=True)
class IdempotencyResult:
    payload: dict[str, Any]
    replayed: bool


def normalize_idempotency_key(value: str | None) -> str:
    """Validate an HTTP Idempotency-Key without persisting caller-controlled junk."""
    key = value.strip() if isinstance(value, str) else ""
    if not key:
        raise ValidationProblem("Idempotency-Key is required for this operation")
    if len(key) > _MAX_KEY_LENGTH or any(char in key for char in "\r\n"):
        raise ValidationProblem("Idempotency-Key is invalid")
    return key


def request_fingerprint(operation: str, body: Any) -> str:
    """Return a stable SHA-256 fingerprint without retaining the request body."""
    canonical = json.dumps(
        {"operation": operation, "body": body},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


class ManagerIdempotencyRepository:
    """RLS-protected receipt store used by F02 and F17.

    ``effect`` runs inside the same ``TenantContext`` transaction as the receipt.
    A unique tenant/operation/key row serializes concurrent retries; a replay
    returns the original safe payload, while a different fingerprint is rejected.
    """

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def execute(
        self,
        ctx: TenantContext,
        *,
        operation: str,
        idempotency_key: str,
        request_fingerprint: str,
        effect: Callable[[Any], dict[str, Any]],
        status_code: int = 200,
    ) -> IdempotencyResult:
        key = normalize_idempotency_key(idempotency_key)
        with self._router.session(ctx) as session:
            row = session.execute(
                "INSERT INTO manager_idempotency_receipt "
                "(tenant_id, operation, idempotency_key, request_fingerprint, state) "
                "VALUES (%s, %s, %s, %s, 'pending') "
                "ON CONFLICT (tenant_id, operation, idempotency_key) DO NOTHING "
                "RETURNING request_fingerprint, state, response_body",
                (ctx.tenant_id, operation, key, request_fingerprint),
            ).fetchone()
            created = row is not None
            if row is None:
                row = session.execute(
                    "SELECT request_fingerprint, state, response_body "
                    "FROM manager_idempotency_receipt "
                    "WHERE tenant_id = %s AND operation = %s AND idempotency_key = %s "
                    "FOR UPDATE",
                    (ctx.tenant_id, operation, key),
                ).fetchone()
            if row is None:
                raise RuntimeError("idempotency receipt unavailable")
            stored_fingerprint, state, response_body = row
            if stored_fingerprint != request_fingerprint:
                raise Conflict("Idempotency-Key was already used for a different request")
            if not created:
                if state != "completed" or response_body is None:
                    raise Conflict("Idempotent request is still in progress")
                if isinstance(response_body, str):
                    response_body = json.loads(response_body)
                return IdempotencyResult(payload=dict(response_body), replayed=True)

            payload = effect(session)
            if not isinstance(payload, dict):
                raise TypeError("idempotent effect must return a JSON object")
            session.execute(
                "UPDATE manager_idempotency_receipt "
                "SET state = 'completed', response_body = %s, status_code = %s, completed_at = now() "
                "WHERE tenant_id = %s AND operation = %s AND idempotency_key = %s",
                (json.dumps(payload, ensure_ascii=False), status_code, ctx.tenant_id, operation, key),
            )
            return IdempotencyResult(payload=payload, replayed=False)


__all__ = [
    "IdempotencyResult",
    "ManagerIdempotencyRepository",
    "normalize_idempotency_key",
    "request_fingerprint",
]
