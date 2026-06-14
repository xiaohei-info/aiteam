"""Tests for event hydrator (L3-S03 T01-T05):

  T01 — raw runtime event → RunTimelineEvent
  T02 — all 18 fixed TimelineEventType values reachable via mapping
  T03 — raw event names not exposed in northbound payload
"""

import json

import pytest

from agent_gateway.contracts import (
    RunTimelineEvent,
    TimelineEventType,
    EventCursor,
    RuntimeRawEvent,
    sse_frame,
)
from agent_gateway.event_hydrator import (
    hydrate,
    hydrate_to_sse_frame,
    get_raw_event_mapping_count,
)

# ── T01: raw runtime event → timeline payload + SSE frame ────────────────

def test_hydrate_raw_to_timeline_event():
    """A single-agent-start raw event must produce a correctly-shaped RunTimelineEvent."""
    raw = RuntimeRawEvent(
        source_type="session",
        source_id="sess_abc",
        raw_event_name="single_agent_started",
        raw_payload={"message": "starting"},
        run_id="run_001",
    )
    cursor: EventCursor = 1

    event = hydrate(raw, cursor, employee_id="emp_001")

    assert isinstance(event, RunTimelineEvent)
    assert event.event_id == "evt_run_001_1"
    assert event.event_cursor == 1
    assert event.run_id == "run_001"
    assert event.event_type == TimelineEventType.RUN_STARTED
    assert event.source_type == "session"
    assert event.source_id == "sess_abc"
    assert event.employee_id == "emp_001"
    assert event.preview == "run_started"
    assert event.payload == {"message": "starting"}


def test_hydrate_to_sse_frame_produces_timeline_event():
    """hydrate_to_sse_frame must emit 'event: timeline' (northbound contract)."""
    raw = RuntimeRawEvent(
        source_type="session",
        source_id="sess_abc",
        raw_event_name="task_stream_delta",
        raw_payload={"delta": "Hello, "},
        run_id="run_001",
    )
    frame = hydrate_to_sse_frame(raw, 3, employee_id="emp_001")
    assert frame.startswith("event: timeline\n")
    assert "data:" in frame
    # The raw event name task_stream_delta must not appear in the SSE frame
    assert "task_stream_delta" not in frame


def test_hydrate_message_delta_preview():
    """message_delta should extract the delta string as preview (truncated to 100 chars)."""
    raw = RuntimeRawEvent(
        source_type="session",
        source_id="sess_a",
        raw_event_name="task_stream_delta",
        raw_payload={"delta": "Hello, world!"},
        run_id="run_1",
    )
    event = hydrate(raw, 0)
    assert event.event_type == TimelineEventType.MESSAGE_DELTA
    assert event.preview == "Hello, world!"


def test_hydrate_long_preview_truncated():
    """Preview longer than 100 chars must be truncated."""
    long_text = "A" * 200
    raw = RuntimeRawEvent(
        source_type="session",
        source_id="sess_a",
        raw_event_name="task_stream_delta",
        raw_payload={"delta": long_text},
        run_id="run_1",
    )
    event = hydrate(raw, 0)
    assert event.event_type == TimelineEventType.MESSAGE_DELTA
    assert len(event.preview) == 100
    assert event.preview == long_text[:100]


# ── T02: all 18 event types have mapping coverage ─────────────────────────

# The 18 fixed northbound event type values per §4.3
FIXED_VALUES = {
    "run_created",
    "routing_decided",
    "run_started",
    "message_delta",
    "tool_call",
    "task_created",
    "task_started",
    "task_completed",
    "task_failed",
    "run_waiting_human",
    "result_merged",
    "memory_written",
    "usage_recorded",
    "run_succeeded",
    "run_failed",
    "run_cancelled",
    "heartbeat",
    "error",
}


def _collect_reachable_types() -> set[str]:
    """Walk the RAW_TO_TIMELINE mapping + special case to collect reachable types."""
    from agent_gateway.event_hydrator import _RAW_TO_TIMELINE

    reachable: set[str] = set()
    for raw_name, mapped in _RAW_TO_TIMELINE.items():
        if mapped is not None:
            reachable.add(mapped.value)
    # run_completed → run_succeeded / run_failed (handled outside the dict)
    reachable.add("run_succeeded")
    reachable.add("run_failed")
    return reachable


def test_all_18_event_types_have_mapping():
    """Every TimelineEventType value must be reachable from some raw event name."""
    reachable = _collect_reachable_types()
    missing = FIXED_VALUES - reachable
    assert not missing, f"Unreachable event types: {missing}"
    extra = reachable - FIXED_VALUES
    assert not extra, f"Unexpected extra types in mapping: {extra}"


def test_run_completed_special_case():
    """run_completed with success=True maps to run_succeeded; success=False to run_failed."""
    raw_ok = RuntimeRawEvent(
        source_type="session", source_id="s_1",
        raw_event_name="run_completed",
        raw_payload={"success": True}, run_id="r1",
    )
    assert hydrate(raw_ok, 0).event_type == TimelineEventType.RUN_SUCCEEDED

    raw_fail = RuntimeRawEvent(
        source_type="session", source_id="s_1",
        raw_event_name="run_completed",
        raw_payload={"success": False}, run_id="r1",
    )
    assert hydrate(raw_fail, 0).event_type == TimelineEventType.RUN_FAILED


def test_unknown_raw_event_defaults_to_error():
    """An un-mapped raw event name should produce event_type=error."""
    raw = RuntimeRawEvent(
        source_type="session", source_id="s_1",
        raw_event_name="some_unknown_event",
        raw_payload={}, run_id="r1",
    )
    event = hydrate(raw, 0)
    assert event.event_type == TimelineEventType.ERROR


# ── T03: raw event names never leak northbound ───────────────────────────

RAW_EVENT_NAMES = [
    "single_agent_started",
    "task_stream_delta",
    "run_completed",
    "tool_execution",
    "job_tick",
]


def test_raw_event_names_not_exposed():
    """No raw Runtime event name must appear in northbound SSE output."""
    for raw_name in RAW_EVENT_NAMES:
        raw = RuntimeRawEvent(
            source_type="session",
            source_id="sess_1",
            raw_event_name=raw_name,
            raw_payload={"success": True} if raw_name == "run_completed" else {},
            run_id="run_001",
        )
        frame = hydrate_to_sse_frame(raw, 1, employee_id="emp_001")
        assert raw_name not in frame, (
            f"Raw event name {raw_name!r} leaked into northbound SSE frame:\n{frame}"
        )


def test_northbound_sse_frame_uses_only_timeline_event_name():
    """All northbound SSE frames must be 'event: timeline'."""
    raw = RuntimeRawEvent(
        source_type="task", source_id="t_1",
        raw_event_name="task_created",
        raw_payload={"task_id": "t_1"}, run_id="r_1",
    )
    frame = hydrate_to_sse_frame(raw, 1)
    assert frame.startswith("event: timeline\n"), (
        f"Wrong SSE event name:\n{frame}"
    )
    # event: must appear exactly once at the start
    assert frame.count("event: ") == 1


def test_northbound_payload_contains_only_mapped_event_types():
    """The serialized payload must carry only TimelineEventType values."""
    raw = RuntimeRawEvent(
        source_type="session", source_id="s_x",
        raw_event_name="heartbeat",
        raw_payload={}, run_id="run_x",
    )
    frame = hydrate_to_sse_frame(raw, 1)
    data_line = [ln for ln in frame.splitlines() if ln.startswith("data:")][0]
    payload = json.loads(data_line[len("data:"):])
    assert payload["event_type"] == "heartbeat"
    assert "raw_event_name" not in payload
    assert "heartbeat" in FIXED_VALUES


# ── Edge cases ────────────────────────────────────────────────────────────

def test_hydrate_without_employee_id():
    """employee_id is optional; omitted employee_id = None in the event."""
    raw = RuntimeRawEvent(
        source_type="session", source_id="s_1",
        raw_event_name="run_cancelled",
        raw_payload={}, run_id="r1",
    )
    event = hydrate(raw, 0)
    assert event.employee_id == ""


def test_get_raw_event_mapping_count():
    """The mapping table should have exactly 18 direct entries."""
    # 18 direct entries (run_completed is handled specially, not in the dict)
    assert get_raw_event_mapping_count() == 18


def test_stream_channel_caps_offline_buffer():
    """Offline subscribers should receive only the bounded tail of buffered events."""
    from agent_gateway.event_hydrator import StreamChannel

    channel = StreamChannel(max_buffer_size=3)
    for index in range(5):
        channel.put_nowait(("timeline", {"index": index}))

    assert channel.diagnostic_snapshot()["offline_buffered_events"] == 3
    subscriber = channel.subscribe()
    received = [subscriber.get_nowait()[1]["index"] for _ in range(3)]
    assert received == [2, 3, 4]
