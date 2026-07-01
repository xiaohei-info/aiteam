"""Operation admin repository (oper library) for lifecycle / quota / audit (issue #413).

Models the Operation-side enterprise lifecycle (active / suspended / banned / closed),
per-enterprise quota (employee / storage / api_rate / token), and enriched audit events
(actor / severity / result / ip_address / user_agent).

Only the Operator writes to these tables; this repository never talks to Manager or Agent.

Dev/test default: in-process memory. Production: PostgreSQL (oper library); same shape.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

from shared.contracts.enums import (
    AuditResult,
    AuditSeverity,
    EnterpriseOperationStatus,
)
from shared.errors import InvalidTransition, NotFound

# --- legacy action string, kept for backward compatibility with existing call sites ---
_NORMAL_TO_ACTIVE = {"normal": "active", "archived": "suspended", "banned": "banned", "active": "active"}


def _normalize_operation_status(value: str) -> str:
    """Best-effort mapping of legacy status strings to the new enum values."""
    if value in {s.value for s in EnterpriseOperationStatus}:
        return value
    return _NORMAL_TO_ACTIVE.get(value, EnterpriseOperationStatus.ACTIVE.value)


def _next_operation_status(current: str, action: str) -> str:
    """Apply a legacy execute_action command to the new operation_status value."""
    cur = _normalize_operation_status(current)
    if action == "reactivate":
        return EnterpriseOperationStatus.ACTIVE.value
    if action in {"suspend", "ban"}:
        if cur == EnterpriseOperationStatus.CLOSED.value:
            raise InvalidTransition(f"cannot {action} a closed enterprise")
        target = (
            EnterpriseOperationStatus.BANNED.value
            if action == "ban"
            else EnterpriseOperationStatus.SUSPENDED.value
        )
        return target
    if action == "close":
        return EnterpriseOperationStatus.CLOSED.value
    return cur


@dataclass
class EnterpriseQuota:
    """Operation-side declared caps for a single enterprise.

    limit=-1 means "unlimited" for that dimension. used is a counter the platform can bump
    (e.g. from rollup summaries) but does not gate Agent execution directly.
    """

    enterprise_id: str
    employee_limit: int = -1
    employee_used: int = 0
    storage_limit_mb: int = -1
    storage_used_mb: int = 0
    api_rate_limit: int = -1
    api_rate_used: int = 0
    token_quota_limit: int = -1
    token_quota_used: int = 0


@dataclass
class EnrichedAuditEvent:
    """Enriched audit event (issue #413).

    In memory it is keyed by a synthetic id; on Postgres the DB-generated uuid is reflected
    back via RETURNING. The surface fields are identical to the API schema.
    """

    event_id: str
    enterprise_id: str
    action: str
    detail: str = ""
    actor_id: str | None = None
    actor_name: str | None = None
    severity: str = AuditSeverity.INFO.value
    result: str = AuditResult.SUCCESS.value
    ip_address: str | None = None
    user_agent: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class EnterpriseAdminState:
    """Operation-side enterprise state."""

    enterprise_id: str
    enterprise_name: str
    owner_phone: str = ""
    operation_status: str = EnterpriseOperationStatus.ACTIVE.value
    total_recharged: Decimal = field(default_factory=lambda: Decimal("0"))
    registered_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    quotas: dict = field(default_factory=dict)
    suspended_at: datetime | None = None
    suspended_reason: str | None = None
    banned_at: datetime | None = None
    banned_reason: str | None = None
    closed_at: datetime | None = None

    # Backward compatibility: old call sites / tests reference `status`.
    @property
    def status(self) -> str:
        return self.operation_status


@dataclass
class RechargeRecord:
    """Single recharge entry."""

    recharge_id: str
    enterprise_id: str
    amount: Decimal
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class AuditEvent:
    """Compatibility wrapper used by legacy call sites."""

    event_id: str
    enterprise_id: str
    action: str
    detail: str
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


def _to_legacy_audit(event: EnrichedAuditEvent) -> AuditEvent:
    return AuditEvent(
        event_id=event.event_id,
        enterprise_id=event.enterprise_id,
        action=event.action,
        detail=event.detail,
        created_at=event.created_at,
    )


# ---------------------------------------------------------------------------
# In-process implementation (dev / test)
# ---------------------------------------------------------------------------


class AdminRepository:
    """Operation-side lifecycle / quota / audit repository (in-process default)."""

    def __init__(self) -> None:
        self._states: dict[str, EnterpriseAdminState] = {}
        self._recharges: list[RechargeRecord] = []
        self._audits: list[EnrichedAuditEvent] = []
        self._quotas: dict[str, EnterpriseQuota] = {}

    # ---- enterprise state ----

    def register_enterprise(
        self, enterprise_id: str, enterprise_name: str, owner_phone: str = ""
    ) -> EnterpriseAdminState:
        if enterprise_id in self._states:
            return self._states[enterprise_id]
        state = EnterpriseAdminState(
            enterprise_id=enterprise_id,
            enterprise_name=enterprise_name,
            owner_phone=owner_phone,
        )
        self._states[enterprise_id] = state
        return state

    def get_state(self, enterprise_id: str) -> EnterpriseAdminState:
        s = self._states.get(enterprise_id)
        if s is None:
            raise NotFound(f"enterprise admin state not found: {enterprise_id}")
        return s

    def set_status(self, enterprise_id: str, status: str) -> EnterpriseAdminState:
        """Legacy setter kept for compatibility; normalizes legacy status strings."""
        s = self.get_state(enterprise_id)
        s.operation_status = _normalize_operation_status(status)
        return s

    def set_operation_status(
        self,
        enterprise_id: str,
        target: str,
        *,
        reason: str | None = None,
        normalized: bool = False,
    ) -> EnterpriseAdminState:
        """Drive the lifecycle state machine (active/suspended/banned/closed)."""
        s = self.get_state(enterprise_id)
        target_value = target if normalized else _normalize_operation_status(target)
        current = s.operation_status
        if current == target_value:
            return s
        self._assert_valid_transition(current, target_value)
        now = datetime.now(timezone.utc)
        s.operation_status = target_value
        if target_value == EnterpriseOperationStatus.SUSPENDED.value:
            s.suspended_at = now
            s.suspended_reason = reason
        elif target_value == EnterpriseOperationStatus.BANNED.value:
            s.banned_at = now
            s.banned_reason = reason
        elif target_value == EnterpriseOperationStatus.CLOSED.value:
            s.closed_at = now
        return s

    @staticmethod
    def _assert_valid_transition(current: str, target: str) -> None:
        if current == target:
            return
        if current == EnterpriseOperationStatus.CLOSED.value:
            raise InvalidTransition(f"closed enterprise can only stay closed; got {target}")
        allowed = {
            EnterpriseOperationStatus.ACTIVE.value: {
                EnterpriseOperationStatus.SUSPENDED.value,
                EnterpriseOperationStatus.BANNED.value,
                EnterpriseOperationStatus.CLOSED.value,
            },
            EnterpriseOperationStatus.SUSPENDED.value: {
                EnterpriseOperationStatus.ACTIVE.value,
                EnterpriseOperationStatus.BANNED.value,
                EnterpriseOperationStatus.CLOSED.value,
            },
            EnterpriseOperationStatus.BANNED.value: {
                EnterpriseOperationStatus.ACTIVE.value,
                EnterpriseOperationStatus.SUSPENDED.value,
                EnterpriseOperationStatus.CLOSED.value,
            },
        }
        if target not in allowed.get(current, set()):
            raise InvalidTransition(f"invalid transition {current} -> {target}")

    # ---- execute_action backward compatibility (legacy service calls) ----

    def apply_action(self, enterprise_id: str, action: str) -> str:
        """Apply a legacy {suspend|ban|reactivate|close} action and return the new status."""
        s = self.get_state(enterprise_id)
        new_status = _next_operation_status(s.operation_status, action)
        s.operation_status = new_status
        now = datetime.now(timezone.utc)
        if new_status == EnterpriseOperationStatus.SUSPENDED.value:
            s.suspended_at = now
        elif new_status == EnterpriseOperationStatus.BANNED.value:
            s.banned_at = now
        elif new_status == EnterpriseOperationStatus.CLOSED.value:
            s.closed_at = now
        return new_status

    # ---- recharge ----

    def add_recharge(self, enterprise_id: str, amount: Decimal) -> RechargeRecord:
        s = self.get_state(enterprise_id)
        s.total_recharged += amount
        rec = RechargeRecord(
            recharge_id=f"rchg:{enterprise_id}:{len(self._recharges)}",
            enterprise_id=enterprise_id,
            amount=amount,
        )
        self._recharges.append(rec)
        return rec

    # ---- quota ----

    def ensure_quota(self, enterprise_id: str) -> EnterpriseQuota:
        q = self._quotas.get(enterprise_id)
        if q is None:
            q = EnterpriseQuota(enterprise_id=enterprise_id)
            self._quotas[enterprise_id] = q
        return q

    def get_quota(self, enterprise_id: str) -> EnterpriseQuota:
        q = self._quotas.get(enterprise_id)
        if q is None:
            raise NotFound(f"quota not found: {enterprise_id}")
        return q

    def update_quota(self, enterprise_id: str, **dims: int) -> EnterpriseQuota:
        q = self.ensure_quota(enterprise_id)
        for key, value in dims.items():
            if hasattr(q, key) and value is not None:
                setattr(q, key, value)
        return q

    # ---- audit ----

    def record_audit(
        self,
        enterprise_id: str,
        action: str,
        detail: str,
        *,
        actor_id: str | None = None,
        actor_name: str | None = None,
        severity: str = AuditSeverity.INFO.value,
        result: str = AuditResult.SUCCESS.value,
        ip_address: str | None = None,
        user_agent: str | None = None,
    ) -> EnrichedAuditEvent:
        evt = EnrichedAuditEvent(
            event_id=f"audit:{enterprise_id}:{len(self._audits)}",
            enterprise_id=enterprise_id,
            action=action,
            detail=detail,
            actor_id=actor_id,
            actor_name=actor_name,
            severity=severity,
            result=result,
            ip_address=ip_address,
            user_agent=user_agent,
        )
        self._audits.append(evt)
        return evt

    # ---- listings ----

    def list_enterprises(
        self, *, keyword: str | None = None, status: str | None = None
    ) -> list[EnterpriseAdminState]:
        results = list(self._states.values())
        if status:
            want = _normalize_operation_status(status)
            results = [s for s in results if s.operation_status == want]
        if keyword:
            kw = keyword.lower()
            results = [
                s
                for s in results
                if kw in s.enterprise_name.lower() or kw in s.enterprise_id.lower()
            ]
        return results

    def list_recharges(self, enterprise_id: str | None = None) -> list[RechargeRecord]:
        if enterprise_id is None:
            return list(self._recharges)
        return [r for r in self._recharges if r.enterprise_id == enterprise_id]

    def list_audits(self, enterprise_id: str | None = None) -> list[AuditEvent]:
        events = self._audits
        if enterprise_id is not None:
            events = [a for a in events if a.enterprise_id == enterprise_id]
        return [_to_legacy_audit(a) for a in sorted(events, key=lambda a: a.created_at, reverse=True)]

    def list_enriched_audits(
        self,
        *,
        enterprise_id: str | None = None,
        severity: str | None = None,
        cursor: int = 0,
        limit: int = 50,
    ) -> tuple[list[EnrichedAuditEvent], int]:
        rows = list(self._audits)
        if enterprise_id is not None:
            rows = [r for r in rows if r.enterprise_id == enterprise_id]
        if severity:
            rows = [r for r in rows if r.severity == severity]
        rows.sort(key=lambda r: r.created_at, reverse=True)
        total = len(rows)
        return rows[cursor : cursor + limit], total

    # ---- aggregates ----

    def total_recharged_all(self) -> Decimal:
        return sum((s.total_recharged for s in self._states.values()), Decimal("0"))

    def enterprise_count(self) -> int:
        return len(self._states)

    def new_this_month(self) -> int:
        now = datetime.now(timezone.utc)
        return sum(1 for s in self._states.values() if (now - s.registered_at).days < 30)

    def monthly_active(self) -> int:
        # Conservative metric: has received at least one recharge in the period under view.
        return len({r.enterprise_id for r in self._recharges})

    def top_consumers(self, n: int = 5) -> list[EnterpriseAdminState]:
        return sorted(self._states.values(), key=lambda s: s.total_recharged, reverse=True)[:n]

    def recharge_trend(self, _period: str) -> list[dict]:
        buckets: dict[str, Decimal] = {}
        for r in self._recharges:
            month_key = r.created_at.strftime("%Y-%m")
            buckets[month_key] = buckets.get(month_key, Decimal("0")) + r.amount
        return [{"period": k, "amount": str(v)} for k, v in sorted(buckets.items())]
