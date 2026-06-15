"""View schemas — stable shapes consumed by frontend/BFF.

All schemas are dataclass-based so query services return typed objects.
Display state is always computed, never persisted into main DB status fields.
"""

from dataclasses import dataclass, field


# ── Workbench ──────────────────────────────────────────────────────────────

@dataclass
class WorkbenchEmployeeItem:
    employee_id: str
    display_name: str = ""
    role_name: str = ""
    status: str = "draft"
    presence: str = "idle"
    avatar_url: str | None = None
    last_message_preview: str = ""
    unread_count: int = 0
    pinned: bool = False
    is_starred: bool = False
    conversation_id: str | None = None
    last_active_at: str = ""
    latest_run_status: str | None = None
    running_task_count: int = 0
    knowledge_base_count: int = 0
    navigation_target: str = ""


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
    navigation_target: str = ""
    latest_run_status: str | None = None
    unread_count: int = 0
    member_count: int = 0
    task_status_digest: dict = field(default_factory=dict)


@dataclass
class WorkbenchView:
    """Aggregate view for the workbench home page."""
    enterprise_id: str
    active_employees: int = 0
    active_conversations: int = 0
    today_runs: int = 0
    today_tokens: int = 0
    recent_conversations: list[WorkbenchConversationItem] = field(default_factory=list)
    employees: list[WorkbenchEmployeeItem] = field(default_factory=list)
    conversations: list[WorkbenchConversationItem] = field(default_factory=list)
    groups: list[WorkbenchConversationItem] = field(default_factory=list)
    my_team: dict = field(default_factory=dict)
    navigation: dict = field(default_factory=dict)
    task_status_digest: dict = field(default_factory=dict)
    office_digest: dict = field(default_factory=dict)
    empty_state: dict | None = None
    permissions: dict = field(default_factory=dict)


# ── Conversation ───────────────────────────────────────────────────────────

# Display states (computed, never persisted):
#   idle | routing | waiting_reply | streaming | busy | resolved | reconnecting

_DISPLAY_RULES = {
    # (run_status, has_message_delta) -> display_state
    ("queued", False): "idle",
    ("routing", False): "routing",
    ("submitting", False): "routing",
    ("running", True): "streaming",
    ("running", False): "busy",
    ("waiting_human", False): "waiting_reply",
    ("succeeded", False): "resolved",
    ("failed", False): "resolved",
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
class OfficeSceneSummary:
    online_employee_count: int = 0
    running_task_count: int = 0
    mode_label: str = "Live"


@dataclass
class OfficeSeatView:
    employee_id: str
    display_name: str = ""
    role_name: str = ""
    presence: str = "offline"
    current_task: str = ""
    conversation_id: str | None = None


@dataclass
class OfficeSceneView:
    summary: OfficeSceneSummary
    seats: list[OfficeSeatView] = field(default_factory=list)


@dataclass
class OfficeFeedItemView:
    employee_id: str
    employee_name: str = ""
    title: str = ""
    detail: str = ""
    status: str = "idle"
    progress: int = 0
    conversation_id: str | None = None


@dataclass
class OfficeFeedView:
    items: list[OfficeFeedItemView] = field(default_factory=list)


# ── Employee Admin ─────────────────────────────────────────────────────────

@dataclass
class EmployeeAdminView:
    """Employee admin detail view — real persisted config surfaces."""
    employee_id: str
    display_name: str = ""
    status: str = "draft"
    role_name: str = ""
    model_provider: str = ""
    model_name: str = ""
    temperature: float = 0.7
    max_tokens: int = 2048
    prompt_version: int = 1
    config_version: int = 1
    capabilities_json: str = "{}"
    description: str = ""
    skills: list = field(default_factory=list)
    knowledge_bases: list = field(default_factory=list)
    memory_config: dict = field(default_factory=dict)
    prompt_config: dict | None = None
    connector_bindings: list = field(default_factory=list)
    bindings_summary: list = field(default_factory=list)
    scheduled_jobs: list = field(default_factory=list)
    run_summary: dict = field(default_factory=dict)
