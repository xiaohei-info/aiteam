"""Manager-issued Hindsight facade leases.

Hindsight 0.12.0 only understands the service API key; it does not expose a
bank-scoped token or token-revocation API. Until that upstream capability exists,
the Manager keeps the service key private and enforces an opaque, short-lived
member lease pointing at an enterprise/employee-private bank. ``HindsightLeaseStore`` remains the
process-local test double; production wires the PostgreSQL implementation from
``hindsight_lease_repository``.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable, Protocol
from urllib.parse import urlsplit

from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden, NotFound

from .hindsight_client import HindsightSettings, HindsightUnavailable
from .hindsight_lease_repository import (
    HindsightLeaseForbidden,
    HindsightLeaseUnauthorized,
    policy_fingerprint,
    token_sha256,
)
from .schemas_hindsight import HindsightLeaseRevocationOut, HindsightRuntimeConfigOut


_FACADE_PATH = "/api/manager/hindsight"
_LEASE_OWNER_ROLES = frozenset(
    {EnterpriseRole.OWNER.value, EnterpriseRole.ENTERPRISE_ADMIN.value}
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class SnapshotAuthorizer(Protocol):
    def _ensure_runnable(self, ctx: TenantContext, *, employee_id: str) -> None: ...

    def generate(
        self,
        ctx: TenantContext,
        *,
        member_id: str,
        employee_id: str,
        employee_version: str | None = None,
    ): ...


@dataclass
class HindsightLease:
    lease_id: str
    # Never include bearer material in an accidental repr/log line.
    token: str = field(repr=False)
    tenant_id: str
    member_id: str
    employee_id: str
    snapshot_version: str
    policy_fingerprint: str
    bank_id: str
    version: int
    issued_at: datetime
    expires_at: datetime
    revoked_at: datetime | None = None
    _now: Callable[[], datetime] = field(default=_utcnow, repr=False, compare=False)

    @property
    def expired(self) -> bool:
        return self._now() >= self.expires_at

    @property
    def active(self) -> bool:
        return self.revoked_at is None and not self.expired


class HindsightLeaseBackend(Protocol):
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
    ) -> HindsightLease: ...

    def get(self, lease_id: str) -> HindsightLease | None: ...

    def revoke(
        self,
        lease_id: str,
        *,
        tenant_id: str | None = None,
        member_id: str | None = None,
        employee_id: str | None = None,
    ) -> HindsightLease | None: ...

    def revoke_scope(
        self, tenant_id: str, member_id: str, employee_id: str
    ) -> HindsightLease | None: ...

    def resolve(self, token: str, *, bank_id: str) -> HindsightLease: ...


class HindsightLeaseStore:
    """Thread-safe process-local test store with the production store's semantics."""

    def __init__(
        self,
        ttl_seconds: int = 300,
        *,
        now: Callable[[], datetime] = _utcnow,
        token_factory: Callable[[], str] = lambda: secrets.token_urlsafe(32),
        lease_id_factory: Callable[[], str] = lambda: secrets.token_urlsafe(18),
    ):
        if ttl_seconds < 1:
            raise ValueError("Hindsight lease TTL must be positive")
        self._ttl = ttl_seconds
        self._now = now
        self._token_factory = token_factory
        self._lease_id_factory = lease_id_factory
        self._by_token_hash: dict[str, HindsightLease] = {}
        self._by_id: dict[str, HindsightLease] = {}
        self._active_by_scope: dict[tuple[str, str, str], HindsightLease] = {}
        self._versions: dict[tuple[str, str, str], int] = {}
        self._lock = threading.RLock()

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
    ) -> HindsightLease:
        with self._lock:
            scope = (tenant_id, member_id, employee_id)
            fingerprint = _policy_fingerprint(snapshot_version, policy)
            current = self._active_by_scope.get(scope)
            if (
                current is not None
                and current.active
                and not force_rotate
                and current.policy_fingerprint == fingerprint
                and current.bank_id == bank_id
            ):
                return current

            if current is not None and current.revoked_at is None:
                current.revoked_at = self._now()
            version = self._versions.get(scope, 0) + 1
            self._versions[scope] = version
            issued_at = self._now()
            lease = HindsightLease(
                lease_id=self._lease_id_factory(),
                token=self._token_factory(),
                tenant_id=tenant_id,
                member_id=member_id,
                employee_id=employee_id,
                snapshot_version=snapshot_version,
                policy_fingerprint=fingerprint,
                bank_id=bank_id,
                version=version,
                issued_at=issued_at,
                expires_at=issued_at + timedelta(seconds=self._ttl),
                _now=self._now,
            )
            self._by_token_hash[token_sha256(lease.token)] = lease
            self._by_id[lease.lease_id] = lease
            self._active_by_scope[scope] = lease
            return lease

    def get(self, lease_id: str) -> HindsightLease | None:
        with self._lock:
            return self._by_id.get(lease_id)

    def revoke(
        self,
        lease_id: str,
        *,
        tenant_id: str | None = None,
        member_id: str | None = None,
        employee_id: str | None = None,
    ) -> HindsightLease | None:
        with self._lock:
            lease = self._by_id.get(lease_id)
            if lease is None:
                return None
            if (
                (tenant_id is not None and lease.tenant_id != tenant_id)
                or (member_id is not None and lease.member_id != member_id)
                or (employee_id is not None and lease.employee_id != employee_id)
            ):
                return None
            if lease.revoked_at is None:
                lease.revoked_at = self._now()
            scope = (lease.tenant_id, lease.member_id, lease.employee_id)
            if self._active_by_scope.get(scope) is lease:
                self._active_by_scope.pop(scope, None)
            return lease

    def revoke_scope(
        self, tenant_id: str, member_id: str, employee_id: str
    ) -> HindsightLease | None:
        with self._lock:
            scope = (tenant_id, member_id, employee_id)
            lease = self._active_by_scope.pop(scope, None)
            if lease is not None and lease.revoked_at is None:
                lease.revoked_at = self._now()
            return lease

    def resolve(self, token: str, *, bank_id: str) -> HindsightLease:
        with self._lock:
            digest = token_sha256(token)
            lease = self._by_token_hash.get(digest)
            if (
                lease is None
                or not hmac.compare_digest(digest, token_sha256(lease.token))
                or not lease.active
            ):
                raise HindsightLeaseUnauthorized("Hindsight lease is expired or revoked")
            if lease.bank_id != bank_id:
                raise HindsightLeaseForbidden("Hindsight lease is not valid for this bank")
            return lease


class HindsightRuntimeService:
    """Authorize a current snapshot, then issue or revoke a facade lease."""

    def __init__(
        self,
        *,
        snapshot_service: SnapshotAuthorizer,
        settings: HindsightSettings | None = None,
        leases: HindsightLeaseBackend | None = None,
        facade_url: str | None = None,
    ):
        self._snapshot = snapshot_service
        self._settings = settings or HindsightSettings.from_env()
        self.leases = leases or HindsightLeaseStore(self._settings.lease_ttl_seconds)
        self._facade_url = facade_url or self._settings.facade_url or _FACADE_PATH
        _validate_facade_url(self._facade_url)

    @property
    def settings(self) -> HindsightSettings:
        return self._settings

    def runtime_config(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        rotate: bool = False,
    ) -> HindsightRuntimeConfigOut:
        try:
            self._snapshot._ensure_runnable(ctx, employee_id=employee_id)
            snapshot = self._snapshot.generate(
                ctx, member_id=ctx.user_id, employee_id=employee_id
            )
        except (Forbidden, NotFound):
            # A grant/lifecycle denial must invalidate a previously issued lease
            # before the denial leaves this process.
            self.leases.revoke_scope(ctx.tenant_id, ctx.user_id, employee_id)
            raise
        if snapshot.employee_id != employee_id:
            raise HindsightLeaseForbidden(
                "employee snapshot does not match requested employee"
            )
        policy = snapshot.memory_policy
        if not isinstance(policy, dict) or policy.get("enabled") is not True:
            self.leases.revoke_scope(ctx.tenant_id, ctx.user_id, employee_id)
            raise HindsightLeaseForbidden("memory policy does not authorize Hindsight")
        self._require_upstream()
        # This is the only bank-id derivation in the Manager lease path. The Agent
        # receives the result as immutable session config and never selects a bank.
        bank_id = derive_hindsight_bank_id(ctx.tenant_id, ctx.user_id, employee_id)
        lease = self.leases.issue(
            tenant_id=ctx.tenant_id,
            member_id=ctx.user_id,
            employee_id=employee_id,
            snapshot_version=snapshot.snapshot_version,
            policy=policy,
            bank_id=bank_id,
            force_rotate=rotate,
        )
        return HindsightRuntimeConfigOut(
            base_url=self._facade_url,
            bank_id=lease.bank_id,
            token=lease.token,
            lease_id=lease.lease_id,
            version=lease.version,
            issued_at=lease.issued_at,
            expires_at=lease.expires_at,
        )

    def revoke(
        self, ctx: TenantContext, *, lease_id: str
    ) -> HindsightLeaseRevocationOut:
        lease = self.leases.get(lease_id)
        if lease is None or lease.tenant_id != ctx.tenant_id:
            raise NotFound("Hindsight lease not found")
        if lease.member_id != ctx.user_id and not set(ctx.roles) & _LEASE_OWNER_ROLES:
            raise NotFound("Hindsight lease not found")
        revoked = self.leases.revoke(
            lease_id,
            tenant_id=lease.tenant_id,
            member_id=lease.member_id,
            employee_id=lease.employee_id,
        )
        if revoked is None:
            raise NotFound("Hindsight lease not found")
        return _revocation_out(revoked)

    def _require_upstream(self) -> None:
        if not (
            isinstance(self._settings.base_url, str)
            and self._settings.base_url.strip()
            and isinstance(self._settings.token, str)
            and self._settings.token.strip()
        ):
            raise HindsightUnavailable(
                "Hindsight facade requires HINDSIGHT_URL and HINDSIGHT_SERVICE_TOKEN"
            )


def derive_hindsight_bank_id(tenant_id: str, member_id: str, employee_id: str) -> str:
    """Derive the enterprise-private employee bank an Agent lease may select.

    ``member_id`` remains in the call signature for wire/backward compatibility;
    it is intentionally not part of the storage scope.  Members authorized to
    the same digital employee share that employee's long-term memory, while the
    lease itself remains member-authenticated.
    """

    digest = hashlib.sha256(
        f"{tenant_id}:{employee_id}".encode()
    ).hexdigest()[:32]
    return f"aiteam-{digest}"


def _policy_fingerprint(snapshot_version: str, policy: dict) -> str:
    return policy_fingerprint(snapshot_version, policy)


def _revocation_out(lease: HindsightLease) -> HindsightLeaseRevocationOut:
    return HindsightLeaseRevocationOut(
        lease_id=lease.lease_id,
        bank_id=lease.bank_id,
        version=lease.version,
        status="expired" if lease.expired else "revoked",
        revoked_at=lease.revoked_at or lease.expires_at,
    )


def _validate_facade_url(value: str) -> None:
    parsed = urlsplit(value)
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError(
            "Hindsight facade URL must not contain query, fragment, or credentials"
        )
    path = parsed.path.rstrip("/") or "/"
    if path != _FACADE_PATH:
        raise ValueError(f"Hindsight facade URL must be {_FACADE_PATH}")
    if parsed.scheme:
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Hindsight facade URL must be an HTTP(S) URL")
    elif not value.startswith("/"):
        raise ValueError(
            "Hindsight facade URL must be absolute HTTP(S) or root-relative"
        )
