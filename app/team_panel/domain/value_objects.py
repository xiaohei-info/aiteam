"""Team Panel value objects — immutable, identity-free."""
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class RuntimeHandleRef:
    """Gateway-level runtime handle (read-side projection).

    Matches Gateway RuntimeHandle.kind (§5.2): session|kanban_task|cron_job|composite.
    注意：数据库 runtime_binding 使用 runtime_kind 枚举（含 profile 不含 composite），
    它是 DB 持久化口径，不是 Gateway 句柄。两层不混淆。"""
    enterprise_id: str
    employee_id: str
    run_id: str
    kind: str       # Gateway: "session" | "kanban_task" | "cron_job" | "composite"
    profile_name: str
    session_id: Optional[str] = None
    task_id: Optional[str] = None
    job_id: Optional[str] = None


@dataclass(frozen=True)
class CredentialRef:
    """Reference to a credential, stored opaquely."""
    credential_id: str
    provider: str
    scope: str = ""


@dataclass(frozen=True)
class Money:
    """Immutable monetary value."""
    amount_cents: int
    currency: str = "CNY"

    def __add__(self, other: "Money") -> "Money":
        if self.currency != other.currency:
            raise ValueError("Currency mismatch")
        return Money(self.amount_cents + other.amount_cents, self.currency)


@dataclass(frozen=True)
class RouteDecision:
    """Result of route_decision_service — immutable snapshot."""
    route_mode: str
    target_employee_ids: tuple[str, ...] = ()
    planner_employee_id: str = ""
