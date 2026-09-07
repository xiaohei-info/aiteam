"""PostgreSQL persistence for Manager-owned Hindsight facade leases.

The business DSN is used for tenant-scoped writes and rotation.  The facade has
no authenticated tenant context, so bearer lookup is an intentionally narrow,
controlled management-DSN query by the SHA-256 token digest.  Raw bearer tokens
are kept only in the short-lived process cache needed to reuse a lease issued by
this process; they are never sent to PostgreSQL.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from datetime import datetime, timedelta, timezone
from typing import Callable

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Forbidden, Unauthorized


_LEASE_COLUMNS = (
    "lease_id, token_sha256, tenant_id, member_id, employee_id, "
    "snapshot_version, policy_fingerprint, bank_id, version, issued_at, "
    "expires_at, revoked_at, allowed_operations, policy_revision, client_protocol"
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def policy_fingerprint(snapshot_version: str, policy: dict) -> str:
    """Return the stable, non-secret policy binding persisted with a lease."""

    canonical = json.dumps(
        {"snapshot_version": snapshot_version, "policy": policy},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def token_sha256(token: str) -> str:
    """Hash bearer material before it crosses the persistence boundary."""

    return hashlib.sha256(token.encode()).hexdigest()


class HindsightLeaseUnauthorized(Unauthorized):
    status, code, title = 401, "hindsight_lease_invalid", "Hindsight lease invalid"


class HindsightLeaseForbidden(Forbidden):
    status, code, title = (
        403,
        "hindsight_lease_scope_denied",
        "Hindsight lease scope denied",
    )


class HindsightLeaseRepository:
    """Durable lease store with tenant-scoped writes and global bearer lookup.

    ``admin_dsn`` is used only for the facade's token-hash lookup, lease-id
    metadata read, and expiry maintenance.  Issue/revoke-by-scope/rotation all use
    ``business_dsn`` through ``PgTenantRouter`` so app_rw + RLS remains the
    write boundary.
    """

    def __init__(
        self,
        business_dsn: str,
        admin_dsn: str,
        ttl_seconds: int = 300,
        *,
        now: Callable[[], datetime] = _utcnow,
        token_factory: Callable[[], str] = lambda: secrets.token_urlsafe(32),
        lease_id_factory: Callable[[], str] = lambda: secrets.token_urlsafe(18),
    ):
        if not business_dsn or not admin_dsn:
            raise ValueError("Hindsight PostgreSQL lease store requires business and admin DSNs")
        if ttl_seconds < 1:
            raise ValueError("Hindsight lease TTL must be positive")
        self._router = PgTenantRouter(business_dsn)
        self._admin_dsn = admin_dsn
        self._ttl = ttl_seconds
        self._now = now
        self._token_factory = token_factory
        self._lease_id_factory = lease_id_factory
        # A restart intentionally loses this cache.  Existing rows remain
        # resolvable by hash; the next runtime-config call rotates because the
        # original raw token cannot be reconstructed from the database.
        self._raw_tokens: dict[str, str] = {}

    def issue(
        self,
        *,
        tenant_id: str,
        member_id: str,
        employee_id: str,
        snapshot_version: str,
        policy: dict,
        bank_id: str,
        force_rotate: bool = False,
        client_protocol: str | None = None,
    ):
        """Reuse or atomically rotate the active scope lease."""

        from .memory_policy_service import normalize_policy

        now = self._now()
        fingerprint = policy_fingerprint(snapshot_version, policy)
        ctx = TenantContext(tenant_id=tenant_id, user_id=member_id)
        scope_key = _scope_key(tenant_id, member_id, employee_id)
        with self._router.session(ctx) as session:
            session.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (scope_key,),
            )
            row = session.execute(
                "SELECT " + _LEASE_COLUMNS + " FROM hindsight_lease "
                "WHERE tenant_id = %s AND member_id = %s AND employee_id = %s "
                "ORDER BY version DESC LIMIT 1 FOR UPDATE",
                (tenant_id, member_id, employee_id),
            ).fetchone()
            if row is not None:
                existing = _row_to_lease(
                    row,
                    token=self._raw_tokens.get(str(row[0]), ""),
                    now=self._now,
                )
                if (
                    existing.active
                    and not force_rotate
                    and existing.policy_fingerprint == fingerprint
                    and existing.bank_id == bank_id
                    and existing.client_protocol == client_protocol
                    and existing.token
                ):
                    return existing
                if existing.revoked_at is None:
                    session.execute(
                        "UPDATE hindsight_lease SET revoked_at = %s "
                        "WHERE lease_id = %s AND revoked_at IS NULL",
                        (now, existing.lease_id),
                    )
                version = existing.version + 1
            else:
                version = 1

            raw_token = self._token_factory()
            lease_id = self._lease_id_factory()
            issued_at = now
            expires_at = issued_at + timedelta(seconds=self._ttl)
            inserted = session.execute(
                "INSERT INTO hindsight_lease "
                "(lease_id, token_sha256, tenant_id, member_id, employee_id, "
                " snapshot_version, policy_fingerprint, bank_id, version, issued_at, expires_at, allowed_operations, policy_revision, client_protocol) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                "RETURNING " + _LEASE_COLUMNS,
                (
                    lease_id,
                    token_sha256(raw_token),
                    tenant_id,
                    member_id,
                    employee_id,
                    snapshot_version,
                    fingerprint,
                    bank_id,
                    version,
                    issued_at,
                    expires_at,
                    json.dumps(normalize_policy(policy)["allowed_operations"]),
                    int(policy.get("revision", 0)),
                    client_protocol,
                ),
            ).fetchone()
        assert inserted is not None
        lease = _row_to_lease(inserted, token=raw_token, now=self._now)
        self._raw_tokens[lease.lease_id] = raw_token
        return lease

    def get(self, lease_id: str):
        """Read lease metadata through the management read path."""

        with self._admin_connection() as conn:
            row = conn.execute(
                "SELECT " + _LEASE_COLUMNS + " FROM hindsight_lease WHERE lease_id = %s",
                (lease_id,),
            ).fetchone()
        return (
            None
            if row is None
            else _row_to_lease(
                row,
                token=self._raw_tokens.get(str(row[0]), ""),
                now=self._now,
            )
        )

    def revoke(
        self,
        lease_id: str,
        *,
        tenant_id: str | None = None,
        member_id: str | None = None,
        employee_id: str | None = None,
    ):
        """Revoke by an already checked scope, retaining legacy id-only callers."""

        if tenant_id is None or member_id is None or employee_id is None:
            # Preserve the legacy store shape without allowing an admin
            # connection to perform a tenant-row write: read metadata globally,
            # then route the actual update through the app_rw scope.
            current = self.get(lease_id)
            if current is None:
                return None
            tenant_id, member_id, employee_id = (
                current.tenant_id,
                current.member_id,
                current.employee_id,
            )

        ctx = TenantContext(tenant_id=tenant_id, user_id=member_id)
        with self._router.session(ctx) as session:
            row = session.execute(
                "UPDATE hindsight_lease SET revoked_at = COALESCE(revoked_at, %s) "
                "WHERE lease_id = %s AND tenant_id = %s AND member_id = %s "
                "AND employee_id = %s RETURNING " + _LEASE_COLUMNS,
                (
                    self._now(),
                    lease_id,
                    tenant_id,
                    member_id,
                    employee_id,
                ),
            ).fetchone()
        return (
            None
            if row is None
            else _row_to_lease(
                row,
                token=self._raw_tokens.get(str(row[0]), ""),
                now=self._now,
            )
        )

    def revoke_scope(self, tenant_id: str, member_id: str, employee_id: str):
        """Revoke the current scope lease using the app_rw tenant session."""

        ctx = TenantContext(tenant_id=tenant_id, user_id=member_id)
        scope_key = _scope_key(tenant_id, member_id, employee_id)
        with self._router.session(ctx) as session:
            session.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (scope_key,),
            )
            row = session.execute(
                "UPDATE hindsight_lease SET revoked_at = COALESCE(revoked_at, %s) "
                "WHERE tenant_id = %s AND member_id = %s AND employee_id = %s "
                "AND revoked_at IS NULL RETURNING " + _LEASE_COLUMNS,
                (
                    self._now(),
                    tenant_id,
                    member_id,
                    employee_id,
                ),
            ).fetchone()
        return (
            None
            if row is None
            else _row_to_lease(
                row,
                token=self._raw_tokens.get(str(row[0]), ""),
                now=self._now,
            )
        )

    def resolve(
        self,
        token: str,
        *,
        bank_id: str,
        tenant_id: str | None = None,
        member_id: str | None = None,
        employee_id: str | None = None,
    ):
        """Resolve a bearer by digest, then explicitly verify active scope."""

        digest = token_sha256(token)
        with self._admin_connection() as conn:
            row = conn.execute(
                "SELECT " + _LEASE_COLUMNS + " FROM hindsight_lease "
                "WHERE token_sha256 = %s",
                (digest,),
            ).fetchone()
        if row is None or not hmac.compare_digest(str(row[1]), digest):
            raise HindsightLeaseUnauthorized("Hindsight lease is expired or revoked")
        lease = _row_to_lease(
            row,
            token=self._raw_tokens.get(str(row[0]), ""),
            now=self._now,
        )
        if not lease.active:
            raise HindsightLeaseUnauthorized("Hindsight lease is expired or revoked")
        if lease.bank_id != bank_id:
            raise HindsightLeaseForbidden("Hindsight lease is not valid for this bank")
        if (
            (tenant_id is not None and lease.tenant_id != tenant_id)
            or (member_id is not None and lease.member_id != member_id)
            or (employee_id is not None and lease.employee_id != employee_id)
        ):
            raise HindsightLeaseForbidden("Hindsight lease scope is not valid")
        return lease

    def cleanup_expired(self) -> int:
        """Mark expired rows as terminal so the active-scope index can advance."""

        with self._admin_connection() as conn:
            cursor = conn.execute(
                "UPDATE hindsight_lease SET revoked_at = expires_at "
                "WHERE revoked_at IS NULL AND expires_at <= %s",
                (self._now(),),
            )
            return int(getattr(cursor, "rowcount", 0))

    def _admin_connection(self):
        import psycopg

        return psycopg.connect(self._admin_dsn, autocommit=True)


def _scope_key(tenant_id: str, member_id: str, employee_id: str) -> str:
    return f"hindsight-lease:{tenant_id}:{member_id}:{employee_id}"


def _row_to_lease(row, *, token: str, now: Callable[[], datetime]):
    from .hindsight_credentials import HindsightLease

    return HindsightLease(
        lease_id=str(row[0]),
        token=token,
        tenant_id=str(row[2]),
        member_id=str(row[3]),
        employee_id=str(row[4]),
        snapshot_version=str(row[5]),
        policy_fingerprint=str(row[6]),
        bank_id=str(row[7]),
        version=int(row[8]),
        issued_at=_as_utc(row[9]),
        expires_at=_as_utc(row[10]),
        revoked_at=None if row[11] is None else _as_utc(row[11]),
        allowed_operations=tuple(row[12] or ()),
        policy_revision=int(row[13] or 0),
        client_protocol=row[14],
        _now=now,
    )


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


# Names used by callers/tests that prefer the implementation-specific spelling.
PgHindsightLeaseStore = HindsightLeaseRepository
HindsightPgLeaseStore = HindsightLeaseRepository
