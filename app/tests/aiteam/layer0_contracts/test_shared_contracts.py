"""Layer 0 shared contracts tests — enums, cursor, RunTimelineEvent, SSE frame."""
import json
import pytest
from agent_gateway.contracts import (
    TimelineEventType,
    ConversationStatus,
    TeamRunStatus,
    TeamTaskStatus,
    ScheduledJobStatus,
    EnterpriseRole,
    SystemRole,
    EventCursor,
    RunTimelineEvent,
    event_to_json,
    event_from_json,
    sse_frame,
)


# ── T01: RunTimelineEvent required fields ────────────────────────────────

def test_run_timeline_event_has_required_fields():
    """RunTimelineEvent must have all required fields per spec §4.2."""
    event = RunTimelineEvent(
        event_id="evt_001",
        event_cursor=1,
        run_id="run_001",
        event_type=TimelineEventType.RUN_CREATED,
        source_type="session",
        source_id="sess_abc",
    )
    assert event.event_id == "evt_001"
    assert event.event_cursor == 1
    assert event.run_id == "run_001"
    assert event.event_type == TimelineEventType.RUN_CREATED
    assert event.source_type == "session"
    assert event.source_id == "sess_abc"
    assert event.employee_id is None
    assert event.preview == ""
    assert event.payload == {}
    assert isinstance(event.event_ts, str)
    assert len(event.event_ts) > 0


# ── T03: ConversationStatus values ───────────────────────────────────────

_EXPECTED_CONVERSATION_STATUSES = {"draft", "active", "paused", "muted", "archived"}


def test_conversation_status_values_match_spec():
    """ConversationStatus must have exactly the 5 fixed values per §6.2."""
    values = set(e.value for e in ConversationStatus)
    assert values == _EXPECTED_CONVERSATION_STATUSES, (
        f"Expected {_EXPECTED_CONVERSATION_STATUSES}, got {values}"
    )


# ── T04: TeamRunStatus / TeamTaskStatus / ScheduledJobStatus ─────────────

_EXPECTED_TEAM_RUN_STATUSES = {"queued", "routing", "submitting", "running", "waiting_human", "succeeded", "failed", "cancelled"}
_EXPECTED_TEAM_TASK_STATUSES = {"planned", "queued", "running", "waiting_deps", "succeeded", "failed", "cancelled"}
_EXPECTED_SCHEDULED_JOB_STATUSES = {"draft", "enabled", "paused", "error", "archived"}


def test_team_run_status_values_match_spec():
    """TeamRunStatus must have exactly the 8 fixed values per §6.4."""
    values = set(e.value for e in TeamRunStatus)
    assert values == _EXPECTED_TEAM_RUN_STATUSES


def test_team_task_status_values_match_spec():
    """TeamTaskStatus must have exactly the 7 fixed values per §6.5."""
    values = set(e.value for e in TeamTaskStatus)
    assert values == _EXPECTED_TEAM_TASK_STATUSES


def test_scheduled_job_status_values_match_spec():
    """ScheduledJobStatus must have exactly the 5 fixed values per §6.6."""
    values = set(e.value for e in ScheduledJobStatus)
    assert values == _EXPECTED_SCHEDULED_JOB_STATUSES


# ── T05: EnterpriseRole / SystemRole + no legacy ─────────────────────────

_EXPECTED_ENTERPRISE_ROLES = {"owner", "enterprise_admin", "finance_admin", "member"}
_EXPECTED_SYSTEM_ROLES = {"system_admin", "system_operator"}

_LEGACY_ROLES = {"admin", "manager", "viewer"}


def test_enterprise_role_values_match_spec():
    """EnterpriseRole must have exactly the 4 fixed values per §8.1."""
    values = set(e.value for e in EnterpriseRole)
    assert values == _EXPECTED_ENTERPRISE_ROLES


def test_system_role_values_match_spec():
    """SystemRole must have exactly the 2 fixed values per §8.2."""
    values = set(e.value for e in SystemRole)
    assert values == _EXPECTED_SYSTEM_ROLES


def test_no_legacy_admin_manager_viewer_roles():
    """No legacy admin/manager/viewer roles should exist in EnterpriseRole or SystemRole."""
    all_role_values = set(e.value for e in EnterpriseRole) | set(e.value for e in SystemRole)
    intersection = all_role_values & _LEGACY_ROLES
    assert intersection == set(), f"Legacy roles found: {intersection}"


# ── T06: EventCursor is int ──────────────────────────────────────────────

def test_event_cursor_is_int_type():
    """EventCursor must be int (bigint) per §5.1."""
    assert EventCursor is int
    event = RunTimelineEvent(
        event_id="evt_001",
        event_cursor=42,
        run_id="run_001",
        event_type=TimelineEventType.RUN_STARTED,
        source_type="session",
        source_id="sess_abc",
    )
    assert isinstance(event.event_cursor, int)
    assert event.event_cursor == 42


# ── T07: TimelineEventType has all 18 fixed types ────────────────────────

_EXPECTED_EVENT_TYPES = {
    "run_created", "routing_decided", "run_started",
    "message_delta", "tool_call",
    "task_created", "task_started", "task_completed", "task_failed",
    "run_waiting_human", "result_merged", "memory_written", "usage_recorded",
    "run_succeeded", "run_failed", "run_cancelled",
    "heartbeat", "error",
}


def test_timeline_event_type_has_all_18_fixed_types():
    """TimelineEventType must have exactly 18 fixed values per §4.3."""
    values = set(e.value for e in TimelineEventType)
    assert len(values) == 18, f"Expected 18 event types, got {len(values)}: {values}"
    assert values == _EXPECTED_EVENT_TYPES


# ── T08: JSON roundtrip ──────────────────────────────────────────────────

def test_run_timeline_event_roundtrip_json():
    """RunTimelineEvent must survive JSON serialization/deserialization with all fields."""
    event = RunTimelineEvent(
        event_id="evt_run_001_129",
        event_cursor=129,
        run_id="run_001",
        event_type=TimelineEventType.MESSAGE_DELTA,
        source_type="session",
        source_id="sess_abc",
        employee_id="emp_marketing_001",
        preview="摘要内容...",
        payload={"delta": "根据今天晨会内容，", "message_id": "msg_221"},
    )
    json_str = event_to_json(event)
    restored = event_from_json(json_str)

    assert restored.event_id == "evt_run_001_129"
    assert restored.event_cursor == 129
    assert restored.run_id == "run_001"
    assert restored.event_type == TimelineEventType.MESSAGE_DELTA
    assert restored.source_type == "session"
    assert restored.source_id == "sess_abc"
    assert restored.employee_id == "emp_marketing_001"
    assert restored.preview == "摘要内容..."
    assert restored.payload == {"delta": "根据今天晨会内容，", "message_id": "msg_221"}
    assert restored.event_ts == event.event_ts


def test_run_timeline_event_roundtrip_json_minimal():
    """Minimal RunTimelineEvent (defaults) must also roundtrip."""
    event = RunTimelineEvent(
        event_id="evt_min",
        event_cursor=1,
        run_id="run_min",
        event_type=TimelineEventType.HEARTBEAT,
        source_type="job",
        source_id="job_001",
    )
    json_str = event_to_json(event)
    restored = event_from_json(json_str)
    assert restored.event_id == "evt_min"
    assert restored.event_cursor == 1
    assert restored.employee_id is None
    assert restored.preview == ""
    assert restored.payload == {}


# ── T09: SSE frame format ────────────────────────────────────────────────

def test_sse_frame_format_is_event_timeline():
    """SSE frame must use 'event: timeline' per §4.1, not raw event types."""
    event = RunTimelineEvent(
        event_id="evt_001",
        event_cursor=1,
        run_id="run_001",
        event_type=TimelineEventType.RUN_STARTED,
        source_type="session",
        source_id="sess_abc",
        preview="Starting...",
    )
    frame = sse_frame(event)
    lines = frame.split("\n")
    assert lines[0] == "event: timeline", f"Expected 'event: timeline', got '{lines[0]}'"
    assert lines[1].startswith("data: "), f"Expected 'data: ...', got '{lines[1]}'"
    # data payload must be valid JSON
    data_json = lines[1][len("data: "):]
    data = json.loads(data_json)
    assert data["event_type"] == "run_started"
    assert data["event_id"] == "evt_001"
    assert data["event_cursor"] == 1
    # Must not expose raw runtime event name as SSE event type
    assert "event: run_started" not in frame


def test_sse_frame_ends_with_double_newline():
    """SSE frame must end with double newline per SSE protocol."""
    event = RunTimelineEvent(
        event_id="evt_001",
        event_cursor=1,
        run_id="run_001",
        event_type=TimelineEventType.HEARTBEAT,
        source_type="session",
        source_id="sess_abc",
    )
    frame = sse_frame(event)
    assert frame.endswith("\n\n"), f"Frame must end with double newline, got: {repr(frame[-10:])}"
