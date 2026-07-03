"""Operation admin repository (oper library) for lifecycle / quota / audit (issue #413).

Models the Operation-side enterprise lifecycle (active / suspended / banned / closed),
per-enterprise quota (employee / storage / api_rate / token), and enriched audit events
(actor / severity / result / ip_address / user_agent).

Only the Operator writes to these tables; this repository never talks to Manager or Agent.

Dev/test default: in-process memory. Production: PostgreSQL (oper library); same shape.
"""

from __future__ import annotations
from abc import ABC, abstractmethod

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
# ---------------------------------------------------------------------------
# Abstract base (common shape across InMemory / Pg implementations)
# ---------------------------------------------------------------------------


class AdminRepositoryBase(ABC):
    """Common shape for the Operation admin (lifecycle / quota / audit) repository.

    Concrete: :class:`AdminRepository` (in-process dev/test default) and
    :class:`PgAdminRepository` (Oper library, selected by ``admin_db_url``).
    """

    @abstractmethod
    def register_enterprise(self, enterprise_id, enterprise_name, owner_phone=""): ...
    @abstractmethod
    def get_state(self, enterprise_id): ...
    @abstractmethod
    def set_status(self, enterprise_id, status): ...
    @abstractmethod
    def set_operation_status(self, enterprise_id, target, *, reason=None, normalized=False): ...
    @abstractmethod
    def apply_action(self, enterprise_id, action): ...
    @abstractmethod
    def add_recharge(self, enterprise_id, amount): ...
    @abstractmethod
    def ensure_quota(self, enterprise_id): ...
    @abstractmethod
    def get_quota(self, enterprise_id): ...
    @abstractmethod
    def update_quota(self, enterprise_id, **dims): ...
    @abstractmethod
    def record_audit(self, enterprise_id, action, detail, *, actor_id=None, actor_name=None,
                     severity="info", result="success", ip_address=None, user_agent=None): ...
    @abstractmethod
    def list_enterprises(self, *, keyword=None, status=None): ...
    @abstractmethod
    def list_recharges(self, enterprise_id=None): ...
    @abstractmethod
    def list_audits(self, enterprise_id=None): ...
    @abstractmethod
    def list_enriched_audits(self, *, enterprise_id=None, severity=None, cursor=0, limit=50): ...
    @abstractmethod
    def total_recharged_all(self): ...
    @abstractmethod
    def enterprise_count(self): ...
    @abstractmethod
    def new_this_month(self): ...
    @abstractmethod
    def monthly_active(self): ...
    @abstractmethod
    def top_consumers(self, n=5): ...
    @abstractmethod
    def recharge_trend(self, _period): ...


# In-process implementation (dev / test)
# ---------------------------------------------------------------------------


class AdminRepository(AdminRepositoryBase):
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


# ---------------------------------------------------------------------------
# PostgreSQL implementation (production, oper library)
# ---------------------------------------------------------------------------


class PgAdminRepository(AdminRepositoryBase):
    """Operation lifecycle / quota / audit repository backed by PostgreSQL (oper library).

    Selected by the DI factory when ``admin_db_url`` is configured. Same method shape
    as :class:`AdminRepository`.
    """

    def __init__(self, dsn):
        self._dsn = dsn

    def _upsert_account(self, enterprise_id, enterprise_name, owner_phone=""):
        import psycopg
        with psycopg.connect(self._dsn, autocommit=False) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM enterprise_account WHERE enterprise_id = %s::uuid",
                    (enterprise_id,),
                )
                if cur.fetchone() is not None:
                    cur.execute(
                        """
                        UPDATE enterprise_account
                           SET enterprise_name = %s, owner_phone = %s, updated_at = now()
                         WHERE enterprise_id = %s::uuid
                        """,
                        (enterprise_name, owner_phone, enterprise_id),
                    )
                else:
                    cur.execute(
                        """
                        INSERT INTO enterprise_account
                            (enterprise_id, tenant_id, enterprise_name, owner_phone,
                             owner_bootstrap_hash, enterprise_code, total_recharged)
                        VALUES (%s::uuid, gen_random_uuid(), %s, %s, '', NULL, 0)
                        ON CONFLICT (enterprise_id) DO UPDATE
                            SET enterprise_name = EXCLUDED.enterprise_name,
                                owner_phone = EXCLUDED.owner_phone
                        """,
                        (enterprise_id, enterprise_name, owner_phone),
                    )
            conn.commit()

    def _fetch_state(self, enterprise_id):
        import psycopg
        from datetime import timezone
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT enterprise_id, enterprise_name, owner_phone, operation_status,
                           total_recharged, created_at,
                           suspended_at, suspended_reason, banned_at, banned_reason, closed_at
                    FROM enterprise_account
                    WHERE enterprise_id = %s::uuid
                    """,
                    (enterprise_id,),
                )
                row = cur.fetchone()
                if row is None:
                    raise NotFound(f"enterprise admin state not found: {enterprise_id}")
        registered = row[5]
        if getattr(registered, "tzinfo", None) is None:
            registered = registered.replace(tzinfo=timezone.utc)
        return EnterpriseAdminState(
            enterprise_id=str(row[0]), enterprise_name=row[1], owner_phone=row[2],
            operation_status=row[3], total_recharged=row[4], registered_at=registered,
            suspended_at=row[6], suspended_reason=row[7], banned_at=row[8],
            banned_reason=row[9], closed_at=row[10],
        )

    def register_enterprise(self, enterprise_id, enterprise_name, owner_phone=""):
        self._upsert_account(enterprise_id, enterprise_name, owner_phone)
        return self._fetch_state(enterprise_id)

    def get_state(self, enterprise_id):
        return self._fetch_state(enterprise_id)

    def set_status(self, enterprise_id, status):
        status_value = _normalize_operation_status(status)
        self.set_operation_status(enterprise_id, status_value, normalized=True)
        return self._fetch_state(enterprise_id)

    def set_operation_status(self, enterprise_id, target, *, reason=None, normalized=False):
        import psycopg
        target_value = target if normalized else _normalize_operation_status(target)
        state = self._fetch_state(enterprise_id)
        if state.operation_status == target_value:
            return state
        AdminRepository._assert_valid_transition(state.operation_status, target_value)
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE enterprise_account
                       SET operation_status = %s,
                           suspended_at = CASE WHEN %s = 'suspended' THEN now() ELSE suspended_at END,
                           suspended_reason = CASE WHEN %s = 'suspended' THEN %s ELSE suspended_reason END,
                           banned_at = CASE WHEN %s = 'banned' THEN now() ELSE banned_at END,
                           banned_reason = CASE WHEN %s = 'banned' THEN %s ELSE banned_reason END,
                           closed_at = CASE WHEN %s = 'closed' THEN now() ELSE closed_at END,
                           updated_at = now()
                     WHERE enterprise_id = %s::uuid
                    """,
                    (
                        target_value, target_value, target_value, reason or "",
                        target_value, target_value, reason or "", target_value,
                        enterprise_id,
                    ),
                )
        return self._fetch_state(enterprise_id)

    def apply_action(self, enterprise_id, action):
        state = self._fetch_state(enterprise_id)
        new_status = _next_operation_status(state.operation_status, action)
        if new_status == state.operation_status:
            return new_status
        self.set_operation_status(enterprise_id, new_status, normalized=True)
        return new_status

    def add_recharge(self, enterprise_id, amount):
        import psycopg
        from datetime import timezone
        with psycopg.connect(self._dsn, autocommit=False) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO operation_recharge_record (enterprise_id, amount) VALUES (%s::uuid, %s)",
                    (enterprise_id, amount),
                )
                cur.execute(
                    "UPDATE enterprise_account SET total_recharged = total_recharged + %s, updated_at = now() WHERE enterprise_id = %s::uuid",
                    (amount, enterprise_id),
                )
                cur.execute(
                    """
                    SELECT recharge_id, enterprise_id, amount, created_at
                    FROM operation_recharge_record
                    WHERE enterprise_id = %s::uuid
                    ORDER BY created_at DESC LIMIT 1
                    """,
                    (enterprise_id,),
                )
                row = cur.fetchone()
            conn.commit()
        created = row[3]
        if getattr(created, "tzinfo", None) is None:
            created = created.replace(tzinfo=timezone.utc)
        return RechargeRecord(recharge_id=str(row[0]), enterprise_id=str(row[1]), amount=row[2], created_at=created)

    def ensure_quota(self, enterprise_id):
        import psycopg
        with psycopg.connect(self._dsn, autocommit=False) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO operation_enterprise_quota (enterprise_id) VALUES (%s::uuid) ON CONFLICT (enterprise_id) DO NOTHING",
                    (enterprise_id,),
                )
                cur.execute(
                    """
                    SELECT enterprise_id, employee_limit, employee_used, storage_limit_mb,
                           storage_used_mb, api_rate_limit, api_rate_used, token_quota_limit,
                           token_quota_used
                    FROM operation_enterprise_quota
                    WHERE enterprise_id = %s::uuid
                    """,
                    (enterprise_id,),
                )
                row = cur.fetchone()
            conn.commit()
        return EnterpriseQuota(
            enterprise_id=str(row[0]),
            employee_limit=row[1], employee_used=row[2],
            storage_limit_mb=row[3], storage_used_mb=row[4],
            api_rate_limit=row[5], api_rate_used=row[6],
            token_quota_limit=row[7], token_quota_used=row[8],
        )

    def get_quota(self, enterprise_id):
        return self.ensure_quota(enterprise_id)

    def update_quota(self, enterprise_id, **dims):
        self.ensure_quota(enterprise_id)
        import psycopg
        assignments = [f"{k} = %s" for k, v in dims.items() if v is not None]
        values = [v for v in dims.values() if v is not None]
        if assignments:
            values.append(enterprise_id)
            with psycopg.connect(self._dsn, autocommit=True) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE operation_enterprise_quota SET " + ", ".join(assignments)
                        + ", updated_at = now() WHERE enterprise_id = %s::uuid",
                        values,
                    )
        return self.ensure_quota(enterprise_id)

    def record_audit(
        self, enterprise_id, action, detail, *,
        actor_id=None, actor_name=None, severity="info", result="success",
        ip_address=None, user_agent=None,
    ):
        import psycopg
        from datetime import timezone
        with psycopg.connect(self._dsn, autocommit=False) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO operation_audit_event
                        (enterprise_id, actor_id, actor_name, action, detail, severity, result,
                         ip_address, user_agent)
                    VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING event_id, created_at
                    """,
                    (enterprise_id, actor_id, actor_name, action, detail, severity,
                     result, ip_address, user_agent),
                )
                row = cur.fetchone()
            conn.commit()
        created = row[1]
        if getattr(created, "tzinfo", None) is None:
            created = created.replace(tzinfo=timezone.utc)
        return EnrichedAuditEvent(
            event_id=str(row[0]), enterprise_id=enterprise_id, action=action, detail=detail,
            actor_id=actor_id, actor_name=actor_name, severity=severity, result=result,
            ip_address=ip_address, user_agent=user_agent, created_at=created,
        )

    def list_enterprises(self, *, keyword=None, status=None):
        import psycopg
        from datetime import timezone
        where, args = [], []
        if status:
            where.append("operation_status = %s"); args.append(_normalize_operation_status(status))
        if keyword:
            where.append("(lower(enterprise_name) LIKE %s OR lower(enterprise_id::text) LIKE %s)")
            args.extend([f"%{keyword.lower()}%", f"%{keyword.lower()}%"])
        sql = (
            "SELECT enterprise_id, enterprise_name, owner_phone, operation_status, total_recharged, "
            "created_at, suspended_at, suspended_reason, banned_at, banned_reason, closed_at "
            "FROM enterprise_account"
        )
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY created_at DESC"
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, args); rows = cur.fetchall()
        out = []
        for r in rows:
            reg = r[5]
            if getattr(reg, "tzinfo", None) is None:
                reg = reg.replace(tzinfo=timezone.utc)
            out.append(EnterpriseAdminState(
                enterprise_id=str(r[0]), enterprise_name=r[1], owner_phone=r[2],
                operation_status=r[3], total_recharged=r[4], registered_at=reg,
                suspended_at=r[6], suspended_reason=r[7], banned_at=r[8],
                banned_reason=r[9], closed_at=r[10],
            ))
        return out

    def list_recharges(self, enterprise_id=None):
        import psycopg
        from datetime import timezone
        sql = "SELECT recharge_id, enterprise_id, amount, created_at FROM operation_recharge_record"
        args = []
        if enterprise_id is None:
            sql += " ORDER BY created_at DESC"
        else:
            sql += " WHERE enterprise_id = %s::uuid ORDER BY created_at DESC"; args.append(enterprise_id)
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, args); rows = cur.fetchall()
        recs = []
        for r in rows:
            c = r[3]
            if getattr(c, "tzinfo", None) is None:
                c = c.replace(tzinfo=timezone.utc)
            recs.append(RechargeRecord(recharge_id=str(r[0]), enterprise_id=str(r[1]), amount=r[2], created_at=c))
        return recs

    def list_audits(self, enterprise_id=None):
        events = self._fetch_audits(enterprise_id)[0]
        return [_to_legacy_audit(e) for e in events]

    def list_enriched_audits(self, *, enterprise_id=None, severity=None, cursor=0, limit=50):
        return self._fetch_audits(enterprise_id, severity, cursor, limit)

    def _fetch_audits(self, enterprise_id=None, severity=None, cursor=0, limit=50):
        import psycopg
        from datetime import timezone
        where, args = [], []
        if enterprise_id is not None:
            where.append("enterprise_id = %s::uuid"); args.append(enterprise_id)
        if severity:
            where.append("severity = %s"); args.append(severity)
        base_from = " FROM operation_audit_event" + (" WHERE " + " AND ".join(where) if where else "")
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*)" + base_from, args)
                total = cur.fetchone()[0]
                sql = (
                    "SELECT event_id, enterprise_id, action, detail, actor_id, actor_name, "
                    "severity, result, ip_address, user_agent, created_at"
                    + base_from + " ORDER BY created_at DESC LIMIT %s OFFSET %s"
                )
                cur.execute(sql, args + [limit, cursor]); rows = cur.fetchall()
        events = []
        for r in rows:
            c = r[10]
            if getattr(c, "tzinfo", None) is None:
                c = c.replace(tzinfo=timezone.utc)
            events.append(EnrichedAuditEvent(
                event_id=str(r[0]), enterprise_id=str(r[1]), action=r[2], detail=r[3],
                actor_id=r[4], actor_name=r[5], severity=r[6], result=r[7],
                ip_address=r[8], user_agent=r[9], created_at=c,
            ))
        return events, total

    def total_recharged_all(self):
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COALESCE(SUM(total_recharged), 0) FROM enterprise_account")
                return cur.fetchone()[0]

    def enterprise_count(self):
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM enterprise_account")
                return cur.fetchone()[0]

    def new_this_month(self):
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM enterprise_account WHERE created_at > now() - interval '30 days'")
                return cur.fetchone()[0]

    def monthly_active(self):
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(DISTINCT enterprise_id) FROM operation_recharge_record")
                return cur.fetchone()[0]

    def top_consumers(self, n=5):
        import psycopg
        from datetime import timezone
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT enterprise_id, enterprise_name, owner_phone, operation_status,
                           total_recharged, created_at, suspended_at, suspended_reason,
                           banned_at, banned_reason, closed_at
                    FROM enterprise_account
                    ORDER BY total_recharged DESC LIMIT %s
                    """,
                    (n,),
                )
                rows = cur.fetchall()
        out = []
        for r in rows:
            reg = r[5]
            if getattr(reg, "tzinfo", None) is None:
                reg = reg.replace(tzinfo=timezone.utc)
            out.append(EnterpriseAdminState(
                enterprise_id=str(r[0]), enterprise_name=r[1], owner_phone=r[2],
                operation_status=r[3], total_recharged=r[4], registered_at=reg,
                suspended_at=r[6], suspended_reason=r[7], banned_at=r[8],
                banned_reason=r[9], closed_at=r[10],
            ))
        return out

    def recharge_trend(self, _period):
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS period,
                           SUM(amount) AS amount
                    FROM operation_recharge_record
                    GROUP BY period ORDER BY period ASC
                    """
                )
                rows = cur.fetchall()
        return [{"period": r[0], "amount": str(r[1] or 0)} for r in rows]
