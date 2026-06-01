"""View schemas — stable shapes consumed by frontend/BFF.

All schemas are dataclass-based so query services return typed objects.
Display state is always computed, never persisted into main DB status fields.
"""

from dataclasses import dataclass, field


# ── Workbench ──────────────────────────────────────────────────────────────

@dataclass
class WorkbenchView:
    """Aggregate view for the workbench home page."""
    enterprise_id: str
    active_employees: int = 0
    active_conversations: int = 0
    today_runs: int = 0
    today_tokens: int = 0
    recent_conversations: list = field(default_factory=list)


@dataclass
class WorkbenchConversationItem:
    """Lightweight conversation projection for workbench."""
    id: str
    title: str = ""
    conv_type: str = "private"  # private | group
    status: str = "draft"
    display_state: str = "idle"
    last_preview: str = ""
    updated_at: str = ""


# ── Conversation ───────────────────────────────────────────────────────────

# Display states (computed, never persisted):
#   idle | routing | waiting_reply | streaming | busy | resolved | reconnecting

_DISPLAY_RULES = {
    # (run_status, has_message_delta) -> display_state
    ("queued",    False): "idle",
    ("routing",   False): "routing",
    ("submitting", False): "routing",
    ("running",   True):  "streaming",
    ("running",   False): "busy",
    ("waiting_human", False): "waiting_reply",
    ("succeeded", False): "resolved",
    ("failed",    False): "resolved",
    ("cancelled", False): "resolved",
}


def compute_display_state(conversation_status: str, run_status: str | None,
                          has_recent_delta: bool = False) -> str:
    """Derive conversation display_state from persisted main statuses.

    Rules (deterministic, smallest set):
    - conversation is not active → idle
    - no latest run → idle
    - terminal run (succeeded/failed/cancelled) → resolved
    - running + recent message_delta → streaming
    - running + no delta yet → busy
    - waiting_human → waiting_reply
    - queued/routing/submitting → idle / routing
    """
    if conversation_status != "active":
        return "idle"
    if run_status is None:
        return "idle"

    key = (run_status, has_recent_delta)
    mapped = _DISPLAY_RULES.get(key)
    if mapped is not None:
        return mapped
    # Fallback for any unhandled status pair
    return "busy"


@dataclass
class ConversationView:
    """Aggregated conversation view with computed display_state."""
    id: str
    conv_type: str = "private"       # private | group
    status: str = "draft"
    display_state: str = "idle"      # computed
    title: str = ""
    last_preview: str = ""
    member_count: int = 0
    updated_at: str = ""


# ── Billing ────────────────────────────────────────────────────────────────

@dataclass
class BillingView:
    """Aggregated billing/usage view for a time window."""
    enterprise_id: str
    period_start: str = ""       # ISO-8601
    period_end: str = ""         # ISO-8601
    total_tokens: int = 0
    total_cost_cents: int = 0
    by_employee: list = field(default_factory=list)


@dataclass
class BillingEmployeeItem:
    """Per-employee billing breakdown."""
    employee_id: str
    display_name: str = ""
    tokens: int = 0
    cost_cents: int = 0


# ── Office ─────────────────────────────────────────────────────────────────

@dataclass
class OfficeView:
    """Lightweight office dashboard view (stub)."""
    enterprise_id: str
    busy_employees: int = 0
    pending_tasks: int = 0
    recent_activity: list = field(default_factory=list)


# ── Employee Admin ─────────────────────────────────────────────────────────

@dataclass
class EmployeeAdminView:
    """Employee admin detail view (stub)."""
    employee_id: str
    display_name: str = ""
    status: str = "draft"
    role_name: str = ""
    model_provider: str = ""
    model_name: str = ""
    bindings_summary: list = field(default_factory=list)
    scheduled_jobs: list = field(default_factory=list)
    run_summary: dict = field(default_factory=dict)
