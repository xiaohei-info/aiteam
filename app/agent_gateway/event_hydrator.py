"""Event hydrator — maps Runtime raw events to RunTimelineEvent.

Hard-coded mapping per L3 plan:  V1 fixed 18 event types, special-case
run_completed based on payload.success.  Raw event names are never exposed
northbound.
"""

from agent_gateway.contracts import (
    RunTimelineEvent,
    TimelineEventType,
    EventCursor,
    RuntimeRawEvent,
    sse_frame as _sse_frame,
)

# ── Raw event name → northbound TimelineEventType ─────────────────────────
# §4.4:  internal raw names like single_agent_started, task_stream_delta,
# run_completed, etc. are mapped BEFORE northbound output.

_RAW_TO_TIMELINE: dict[str, TimelineEventType] = {
    "single_agent_started": TimelineEventType.RUN_STARTED,
    "task_stream_delta": TimelineEventType.MESSAGE_DELTA,
    "run_created": TimelineEventType.RUN_CREATED,
    "routing_decided": TimelineEventType.ROUTING_DECIDED,
    "tool_execution": TimelineEventType.TOOL_CALL,
    "task_created": TimelineEventType.TASK_CREATED,
    "task_started": TimelineEventType.TASK_STARTED,
    "task_completed": TimelineEventType.TASK_COMPLETED,
    "task_failed": TimelineEventType.TASK_FAILED,
    "waiting_human": TimelineEventType.RUN_WAITING_HUMAN,
    "result_merged": TimelineEventType.RESULT_MERGED,
    "memory_written": TimelineEventType.MEMORY_WRITTEN,
    "usage_recorded": TimelineEventType.USAGE_RECORDED,
    "run_failed": TimelineEventType.RUN_FAILED,
    "run_cancelled": TimelineEventType.RUN_CANCELLED,
    "heartbeat": TimelineEventType.HEARTBEAT,
    "error": TimelineEventType.ERROR,
    "job_tick": TimelineEventType.RUN_STARTED,
}


def hydrate(raw: RuntimeRawEvent, cursor: EventCursor,
            employee_id: str = "") -> RunTimelineEvent:
    """Convert a Runtime raw event into a RunTimelineEvent for northbound SSE."""
    event_type = _map_event_type(raw)
    return RunTimelineEvent(
        event_id=f"evt_{raw.run_id}_{cursor}",
        event_cursor=cursor,
        run_id=raw.run_id,
        event_type=event_type,
        source_type=raw.source_type,
        source_id=raw.source_id,
        employee_id=employee_id,
        preview=_extract_preview(raw, event_type),
        payload=raw.raw_payload,
    )


def _map_event_type(raw: RuntimeRawEvent) -> TimelineEventType:
    """Resolve the northbound event type, handling run_completed specially."""
    if raw.raw_event_name == "run_completed":
        success = raw.raw_payload.get("success", True)
        return TimelineEventType.RUN_SUCCEEDED if success else TimelineEventType.RUN_FAILED
    mapped = _RAW_TO_TIMELINE.get(raw.raw_event_name)
    if mapped is None:
        return TimelineEventType.ERROR
    return mapped


def _extract_preview(raw: RuntimeRawEvent, event_type: TimelineEventType) -> str:
    """Build a short preview string for the timeline."""
    delta: str = raw.raw_payload.get("delta", "")
    return delta[:100] if delta else event_type.value


def hydrate_to_sse_frame(raw: RuntimeRawEvent, cursor: EventCursor,
                         employee_id: str = "") -> str:
    """Hydrate a raw event and format as a northbound SSE frame in one call.

    SSE format (§4.1):
        event: timeline
        data: {RunTimelineEvent JSON}
    """
    event = hydrate(raw, cursor, employee_id)
    return _sse_frame(event)


def get_raw_event_mapping_count() -> int:
    """Return the number of raw event names that have a direct mapping.

    Excludes the special-cased run_completed handler.
    """
    return len(_RAW_TO_TIMELINE)
