"""Shared contracts for AI Team layers L0-L5. Single source of truth for
event envelopes, cursors, status enums, roles, and gateway request/response
schemas. All upper layers import from here — no private redefinitions."""

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Optional
import json
import time

# ── Event types ──────────────────────────────────────────────────────────

class TimelineEventType(StrEnum):
    """V1 fixed event types per 共享运行口径定稿版 §4.3"""
    RUN_CREATED = "run_created"
    ROUTING_DECIDED = "routing_decided"
    RUN_STARTED = "run_started"
    MESSAGE_DELTA = "message_delta"
    TOOL_CALL = "tool_call"
    TASK_CREATED = "task_created"
    TASK_STARTED = "task_started"
    TASK_COMPLETED = "task_completed"
    TASK_FAILED = "task_failed"
    RUN_WAITING_HUMAN = "run_waiting_human"
    RESULT_MERGED = "result_merged"
    MEMORY_WRITTEN = "memory_written"
    USAGE_RECORDED = "usage_recorded"
    RUN_SUCCEEDED = "run_succeeded"
    RUN_FAILED = "run_failed"
    RUN_CANCELLED = "run_cancelled"
    HEARTBEAT = "heartbeat"
    ERROR = "error"

# ── Status enums ─────────────────────────────────────────────────────────

class ConversationStatus(StrEnum):
    """持久化主状态 per §6.2"""
    DRAFT = "draft"
    ACTIVE = "active"
    PAUSED = "paused"
    MUTED = "muted"
    ARCHIVED = "archived"

class TeamRunStatus(StrEnum):
    """持久化主状态 per §6.4"""
    QUEUED = "queued"
    ROUTING = "routing"
    SUBMITTING = "submitting"
    RUNNING = "running"
    WAITING_HUMAN = "waiting_human"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"

class TeamTaskStatus(StrEnum):
    """持久化主状态 per §6.5"""
    PLANNED = "planned"
    QUEUED = "queued"
    RUNNING = "running"
    WAITING_DEPS = "waiting_deps"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"

class ScheduledJobStatus(StrEnum):
    """持久化主状态 per §6.6"""
    DRAFT = "draft"
    ENABLED = "enabled"
    PAUSED = "paused"
    ERROR = "error"
    ARCHIVED = "archived"

# ── Role enums ───────────────────────────────────────────────────────────

class EnterpriseRole(StrEnum):
    """企业侧角色 per §8.1"""
    OWNER = "owner"
    ENTERPRISE_ADMIN = "enterprise_admin"
    FINANCE_ADMIN = "finance_admin"
    MEMBER = "member"

class SystemRole(StrEnum):
    """平台侧角色 per §8.2"""
    SYSTEM_ADMIN = "system_admin"
    SYSTEM_OPERATOR = "system_operator"

# ── Cursor ───────────────────────────────────────────────────────────────

EventCursor = int  # bigint, monotonic per run_id (§5.1)

# ── Expected fixed type count ────────────────────────────────────────────

_FIXED_EVENT_TYPE_COUNT = 18

# ── RunTimelineEvent ─────────────────────────────────────────────────────

def _utcnow_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


@dataclass
class RunTimelineEvent:
    """北向 SSE 统一事件模型 per §4"""
    event_id: str
    event_cursor: EventCursor
    run_id: str
    event_type: TimelineEventType
    source_type: str          # "session" | "task" | "job"
    source_id: str
    employee_id: Optional[str] = None
    event_ts: str = field(default_factory=_utcnow_iso)
    preview: str = ""
    payload: dict = field(default_factory=dict)


# ── Serialization helpers ────────────────────────────────────────────────

def event_to_json(event: RunTimelineEvent) -> str:
    """Serialize a RunTimelineEvent to JSON string."""
    d = {
        "event_id": event.event_id,
        "event_cursor": event.event_cursor,
        "run_id": event.run_id,
        "event_type": event.event_type.value if isinstance(event.event_type, TimelineEventType) else event.event_type,
        "source_type": event.source_type,
        "source_id": event.source_id,
        "employee_id": event.employee_id,
        "event_ts": event.event_ts,
        "preview": event.preview,
        "payload": event.payload,
    }
    return json.dumps(d, ensure_ascii=False)


def event_from_json(s: str) -> RunTimelineEvent:
    """Deserialize a JSON string back into a RunTimelineEvent."""
    d = json.loads(s)
    return RunTimelineEvent(
        event_id=d["event_id"],
        event_cursor=d["event_cursor"],
        run_id=d["run_id"],
        event_type=TimelineEventType(d["event_type"]),
        source_type=d["source_type"],
        source_id=d["source_id"],
        employee_id=d.get("employee_id"),
        event_ts=d["event_ts"],
        preview=d.get("preview", ""),
        payload=d.get("payload", {}),
    )


def sse_frame(event: RunTimelineEvent) -> str:
    """Format a RunTimelineEvent as a standard northbound SSE frame.

    Northbound SSE format per §4.1:
        event: timeline
        data: {RunTimelineEvent JSON}
    """
    return f"event: timeline\ndata: {event_to_json(event)}\n\n"


# ── Gateway Internal Contracts ──────────────────────────────────────────

_VALID_RUNTIME_HANDLE_KINDS = frozenset({"session", "kanban_task", "cron_job", "composite"})
_VALID_ROUTE_MODES = frozenset({"auto", "single_agent", "orchestration"})


@dataclass
class RuntimeHandle:
    """Runtime handle minimal set per Gateway detailed design §5.2.

    NOTE: Gateway-layer ``kind`` uses session|kanban_task|cron_job|composite,
    which differs from the database ``runtime_binding.runtime_kind`` (which
    includes ``profile`` but omits ``composite``). The two enums live at
    different layers and must not be conflated.
    """
    enterprise_id: str
    employee_id: str
    run_id: str
    kind: str                   # "session" | "kanban_task" | "cron_job" | "composite"
    profile_name: str
    session_id: Optional[str] = None
    task_id: Optional[str] = None
    job_id: Optional[str] = None

    def __post_init__(self):
        if self.kind not in _VALID_RUNTIME_HANDLE_KINDS:
            raise ValueError(
                f"Invalid RuntimeHandle kind: {self.kind!r}. "
                f"Must be one of {sorted(_VALID_RUNTIME_HANDLE_KINDS)}"
            )


@dataclass
class SingleAgentRunRequest:
    """Single-agent private-chat run request."""
    run_id: str
    employee_id: str
    conversation_id: str
    message_text: str
    enterprise_id: str = ""
    profile_name: str = ""
    workspace_id: str = "ws_default"
    idempotency_key: str = ""
    attachments: list = field(default_factory=list)

    def __post_init__(self):
        if not self.idempotency_key.strip():
            raise ValueError("idempotency_key is required for SingleAgentRunRequest")


@dataclass
class GroupConversationRunRequest:
    """Group conversation message submission."""
    run_id: str
    conversation_id: str
    message_text: str
    route_mode: str = "auto"    # "auto" | "single_agent" | "orchestration"
    employee_id: str = ""
    planner_employee_id: str = ""
    target_employee_ids: list[str] = field(default_factory=list)
    message_id: str = ""
    idempotency_key: str = ""

    def __post_init__(self):
        if self.route_mode not in _VALID_ROUTE_MODES:
            raise ValueError(
                f"Invalid route_mode: {self.route_mode!r}. "
                f"Must be one of {sorted(_VALID_ROUTE_MODES)}"
            )
        if not self.idempotency_key.strip():
            raise ValueError("idempotency_key is required for GroupConversationRunRequest")


@dataclass
class OrchestrationRunRequest:
    """Orchestration task request."""
    run_id: str
    conversation_id: str
    root_task_context: dict
    target_employee_ids: list = field(default_factory=list)
    planner_employee_id: str = ""
    idempotency_key: str = ""

    def __post_init__(self):
        if not self.idempotency_key.strip():
            raise ValueError("idempotency_key is required for OrchestrationRunRequest")


@dataclass
class ScheduledJobRunRequest:
    """Loop / ScheduledJob trigger execution."""
    run_id: str
    job_id: str
    employee_id: str
    idempotency_key: str = ""

    def __post_init__(self):
        if not self.idempotency_key.strip():
            raise ValueError("idempotency_key is required for ScheduledJobRunRequest")


@dataclass
class GatewayAcceptResponse:
    """Gateway synchronous acceptance response."""
    run_id: str
    status: str                 # "queued"
    runtime_handle: RuntimeHandle
    stream_url: str
    events_url: str


def validate_runtime_handle_kind(kind: str) -> None:
    """Raise ValueError if *kind* is not a valid RuntimeHandle.kind value."""
    if kind not in _VALID_RUNTIME_HANDLE_KINDS:
        raise ValueError(
            f"Invalid RuntimeHandle kind: {kind!r}. "
            f"Must be one of {sorted(_VALID_RUNTIME_HANDLE_KINDS)}"
        )


def validate_route_mode(mode: str) -> None:
    """Raise ValueError if *mode* is not a valid route_mode value."""
    if mode not in _VALID_ROUTE_MODES:
        raise ValueError(
            f"Invalid route_mode: {mode!r}. "
            f"Must be one of {sorted(_VALID_ROUTE_MODES)}"
        )


def validate_idempotency_key(key: str, label: str = "request") -> None:
    """Raise ValueError if *key* is empty or whitespace-only."""
    if not isinstance(key, str) or not key.strip():
        raise ValueError(f"idempotency_key is required for {label}")


# ── Gateway Internal: Runtime raw event ──────────────────────────────────

@dataclass
class RuntimeRawEvent:
    """Internal: a raw event coming from Hermes Runtime before hydration.

    Northbound consumers never see RuntimeRawEvent — it is converted to
    RunTimelineEvent before output.
    """
    source_type: str        # "session" | "task" | "job"
    source_id: str
    raw_event_name: str     # e.g. "single_agent_started", "task_stream_delta"
    raw_payload: dict
    run_id: str = ""
