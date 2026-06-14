"""Event hydrator — maps Runtime raw events to RunTimelineEvent,
and manages per-run StreamChannels for northbound SSE broadcast.

Design doc: §9.4 of Agent Gateway运行时适配与事件流详细设计.

Hard-coded mapping per L3 plan:  V1 fixed 18 event types, special-case
run_completed based on payload.success.  Raw event names are never exposed
northbound.

The EventHydrator also manages StreamChannels so that the northbound SSE
endpoint (/api/team/runs/{id}/stream) can push events in real-time to
connected frontend clients.  DB writes happen via _ingest_standalone in
runtime_executor; the EventHydrator only handles SSE broadcast.
"""

import logging
import queue
import threading
from typing import Optional

from agent_gateway.contracts import (
    RunTimelineEvent,
    TimelineEventType,
    EventCursor,
    RuntimeRawEvent,
    sse_frame as _sse_frame,
    event_to_json,
)

logger = logging.getLogger(__name__)

# ── StreamChannel (lightweight broadcast) ─────────────────────────────────


class StreamChannel:
    """Broadcast SSE events to every connected subscriber for a run stream.

    While no subscriber is connected, a bounded tail is buffered so a late
    subscriber can catch up without unbounded memory growth.
    """

    def __init__(self, max_buffer_size: int = 200):
        self._lock = threading.Lock()
        self._subscribers: list[queue.Queue] = []
        self._offline_buffer: list[tuple[str, object]] = []
        self._max_buffer_size = max(1, int(max_buffer_size or 1))

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self._lock:
            for item in self._offline_buffer:
                q.put_nowait(item)
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            try:
                self._subscribers.remove(q)
            except ValueError:
                pass

    def put_nowait(self, item: tuple[str, object]) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
            if not subscribers:
                self._offline_buffer.append(item)
                overflow = len(self._offline_buffer) - self._max_buffer_size
                if overflow > 0:
                    del self._offline_buffer[:overflow]
                return
            self._offline_buffer.clear()
        for q in subscribers:
            q.put_nowait(item)

    def diagnostic_snapshot(self) -> dict[str, int]:
        with self._lock:
            return {
                "subscriber_count": len(self._subscribers),
                "offline_buffered_events": len(self._offline_buffer),
                "max_buffer_size": self._max_buffer_size,
            }


# ── EventHydrator (SSE broadcast manager) ────────────────────────────────


class EventHydrator:
    """Gateway SSE proxy — registers per-run StreamChannels, pushes events
    to subscribers, and closes streams on run termination.

    DB writes are handled by _ingest_standalone in runtime_executor; this
    class only handles the SSE broadcast side.
    """

    def __init__(self):
        self._streams: dict[str, StreamChannel] = {}
        self._streams_lock = threading.Lock()

    def register_stream(self, run_id: str) -> StreamChannel:
        """Register a StreamChannel for a run; call when run starts."""
        with self._streams_lock:
            if run_id not in self._streams:
                self._streams[run_id] = StreamChannel()
                logger.debug("[hydrator] registered stream for run %s", run_id)
            return self._streams[run_id]

    def push_event(self, run_id: str, event: RunTimelineEvent) -> None:
        """Broadcast a RunTimelineEvent to all SSE subscribers (no DB wait)."""
        stream = self._streams.get(run_id)
        if stream is not None:
            stream.put_nowait(("timeline", event_to_json(event)))

    def subscribe_stream(self, run_id: str) -> Optional[StreamChannel]:
        """Return the active StreamChannel for a run (if any)."""
        return self._streams.get(run_id)

    def close_stream(self, run_id: str) -> None:
        """Signal stream_end to all subscribers."""
        stream = self._streams.get(run_id)
        if stream is not None:
            stream.put_nowait(("stream_end", {}))
            logger.debug("[hydrator] closed stream for run %s", run_id)

    def remove_stream(self, run_id: str) -> None:
        """Remove the StreamChannel dict entry (after close)."""
        with self._streams_lock:
            self._streams.pop(run_id, None)
            logger.debug("[hydrator] removed stream entry for run %s", run_id)

    def has_active_stream(self, run_id: str) -> bool:
        """Check whether a run currently has an active StreamChannel."""
        return run_id in self._streams


# ── Global singleton ──────────────────────────────────────────────────────

_hydrator = EventHydrator()


def get_hydrator() -> EventHydrator:
    """Return the global EventHydrator instance."""
    return _hydrator


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
