"""Durable Operator F01 receipts.

The receipt is created before any Manager fanout.  It binds the caller's
canonical request fingerprint to generated enterprise/tenant IDs and an
encrypted one-time bootstrap secret.  A prepared receipt can safely resume a
lost fanout; a completed receipt returns the original result without creating a
second Manager tenant.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
from dataclasses import dataclass, field, replace
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from shared.errors import Conflict, ServiceUnavailable, ValidationProblem

_MAX_KEY_LENGTH = 256


def normalize_idempotency_key(value: str | None) -> str:
    key = value.strip() if isinstance(value, str) else ""
    if not key:
        raise ValidationProblem("Idempotency-Key is required for enterprise provisioning")
    if len(key) > _MAX_KEY_LENGTH or any(char in key for char in "\r\n"):
        raise ValidationProblem("Idempotency-Key is invalid")
    return key


def canonical_request_fingerprint(body: dict[str, Any]) -> str:
    canonical = json.dumps(
        body,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


@dataclass(frozen=True)
class OnboardingReceipt:
    idempotency_key: str
    request_fingerprint: str
    state: str
    request_body: dict[str, Any]
    enterprise_id: str
    tenant_id: str
    enterprise_name: str
    enterprise_code: str | None
    owner_phone: str
    bootstrap_secret_ciphertext: str
    _cipher: _SecretCipher = field(repr=False, compare=False)
    safe_response: dict[str, Any] | None = None

    @property
    def bootstrap_secret(self) -> str:
        """Decrypt only for the short-lived fanout call; never retain plaintext."""
        return self._cipher.decrypt(self.bootstrap_secret_ciphertext)


class _SecretCipher:
    def __init__(self, *, allow_ephemeral: bool):
        raw = os.getenv("OPERATION_ONBOARDING_RECEIPT_KEY") or os.getenv("OPERATION_PROVIDER_CREDENTIAL_KEY")
        if raw:
            try:
                self._cipher = Fernet(raw.encode("ascii"))
            except (ValueError, UnicodeEncodeError) as exc:
                raise ServiceUnavailable("Operator onboarding receipt encryption is unavailable") from exc
        elif allow_ephemeral:
            # In-memory repositories are explicitly dev/test only.  They still
            # avoid retaining a plaintext secret in the receipt object.
            self._cipher = Fernet(Fernet.generate_key())
        else:
            raise ServiceUnavailable("Operator onboarding receipt encryption is not configured")

    def encrypt(self, value: str) -> str:
        return self._cipher.encrypt(value.encode("utf-8")).decode("ascii")

    def decrypt(self, value: str) -> str:
        try:
            return self._cipher.decrypt(value.encode("ascii")).decode("utf-8")
        except (InvalidToken, UnicodeError, ValueError) as exc:
            raise ServiceUnavailable("Operator onboarding receipt encryption is unavailable") from exc


class InMemoryOnboardingReceiptStore:
    def __init__(self):
        self._rows: dict[str, OnboardingReceipt] = {}
        self._cipher = _SecretCipher(allow_ephemeral=True)
        self._lock = threading.RLock()

    def reserve(
        self,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        request_body: dict[str, Any],
        enterprise_id: str,
        tenant_id: str,
        enterprise_name: str,
        enterprise_code: str | None,
        owner_phone: str,
        bootstrap_secret: str,
    ) -> OnboardingReceipt:
        with self._lock:
            existing = self._rows.get(idempotency_key)
            if existing is not None:
                if existing.request_fingerprint != request_fingerprint:
                    raise Conflict("Idempotency-Key was already used for a different request")
                return existing
            receipt = OnboardingReceipt(
                idempotency_key=idempotency_key,
                request_fingerprint=request_fingerprint,
                state="prepared",
                request_body=dict(request_body),
                enterprise_id=enterprise_id,
                tenant_id=tenant_id,
                enterprise_name=enterprise_name,
                enterprise_code=enterprise_code,
                owner_phone=owner_phone,
                bootstrap_secret_ciphertext=self._cipher.encrypt(bootstrap_secret),
                _cipher=self._cipher,
            )
            self._rows[idempotency_key] = receipt
            return receipt

    def complete(self, idempotency_key: str, safe_response: dict[str, Any]) -> None:
        with self._lock:
            existing = self._rows.get(idempotency_key)
            if existing is None:
                raise ServiceUnavailable("Operator onboarding receipt disappeared")
            self._rows[idempotency_key] = replace(
                existing, state="completed", safe_response=dict(safe_response)
            )


class PgOnboardingReceiptStore:
    def __init__(self, dsn: str):
        self._dsn = dsn
        self._cipher = _SecretCipher(allow_ephemeral=False)

    @staticmethod
    def _row_to_receipt(row, cipher: _SecretCipher) -> OnboardingReceipt:
        response = row[11]
        if isinstance(response, str):
            response = json.loads(response)
        return OnboardingReceipt(
            idempotency_key=row[0],
            request_fingerprint=row[1],
            state=row[2],
            request_body=dict(row[3]),
            enterprise_id=str(row[4]),
            tenant_id=str(row[5]),
            enterprise_name=row[6],
            enterprise_code=row[7],
            owner_phone=row[8],
            bootstrap_secret_ciphertext=row[9],
            _cipher=cipher,
            safe_response=response,
        )

    def reserve(self, **kwargs) -> OnboardingReceipt:
        import psycopg
        from psycopg import errors as pg_errors

        key = kwargs["idempotency_key"]
        try:
            with psycopg.connect(self._dsn) as conn:
                row = conn.execute(
                    "INSERT INTO onboarding_receipt "
                    "(idempotency_key, request_fingerprint, state, request_body, enterprise_id, tenant_id, "
                    "enterprise_name, enterprise_code, owner_phone, bootstrap_secret_ciphertext) "
                    "VALUES (%s, %s, 'prepared', %s, %s, %s, %s, %s, %s, %s) "
                    "ON CONFLICT (idempotency_key) DO NOTHING RETURNING "
                    "idempotency_key, request_fingerprint, state, request_body, enterprise_id, tenant_id, "
                    "enterprise_name, enterprise_code, owner_phone, bootstrap_secret_ciphertext, completed_at, response_body",
                    (
                        key,
                        kwargs["request_fingerprint"],
                        json.dumps(kwargs["request_body"], ensure_ascii=False),
                        kwargs["enterprise_id"],
                        kwargs["tenant_id"],
                        kwargs["enterprise_name"],
                        kwargs["enterprise_code"],
                        kwargs["owner_phone"],
                        self._cipher.encrypt(kwargs["bootstrap_secret"]),
                    ),
                ).fetchone()
                if row is None:
                    row = conn.execute(
                        "SELECT idempotency_key, request_fingerprint, state, request_body, enterprise_id, tenant_id, "
                        "enterprise_name, enterprise_code, owner_phone, bootstrap_secret_ciphertext, completed_at, response_body "
                        "FROM onboarding_receipt WHERE idempotency_key=%s FOR UPDATE",
                        (key,),
                    ).fetchone()
                if row is None:
                    raise ServiceUnavailable("Operator onboarding receipt is unavailable")
                receipt = self._row_to_receipt(row, self._cipher)
                if receipt.request_fingerprint != kwargs["request_fingerprint"]:
                    raise Conflict("Idempotency-Key was already used for a different request")
                return receipt
        except Conflict:
            raise
        except (pg_errors.Error, OSError) as exc:
            raise ServiceUnavailable("Operator onboarding receipt database is unavailable") from exc

    def complete(self, idempotency_key: str, safe_response: dict[str, Any]) -> None:
        import psycopg
        from psycopg import errors as pg_errors

        try:
            with psycopg.connect(self._dsn, autocommit=True) as conn:
                updated = conn.execute(
                    "UPDATE onboarding_receipt SET state='completed', response_body=%s, completed_at=now() "
                    "WHERE idempotency_key=%s",
                    (json.dumps(safe_response, ensure_ascii=False), idempotency_key),
                )
                if updated.rowcount != 1:
                    raise ServiceUnavailable("Operator onboarding receipt disappeared")
        except ServiceUnavailable:
            raise
        except (pg_errors.Error, OSError) as exc:
            raise ServiceUnavailable("Operator onboarding receipt database is unavailable") from exc


def build_onboarding_receipt_store(repository) -> InMemoryOnboardingReceiptStore | PgOnboardingReceiptStore:
    existing = getattr(repository, "_onboarding_receipt_store", None)
    if existing is not None:
        return existing
    dsn = getattr(repository, "_dsn", None)
    store = PgOnboardingReceiptStore(dsn) if dsn else InMemoryOnboardingReceiptStore()
    setattr(repository, "_onboarding_receipt_store", store)
    return store


__all__ = [
    "InMemoryOnboardingReceiptStore",
    "OnboardingReceipt",
    "PgOnboardingReceiptStore",
    "build_onboarding_receipt_store",
    "canonical_request_fingerprint",
    "normalize_idempotency_key",
]
