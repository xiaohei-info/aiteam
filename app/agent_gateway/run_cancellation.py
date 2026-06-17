"""Live runtime cancellation registry for AI Team runs.

This is intentionally process-local: AI Team execution currently runs in the
same WebUI process as the Team Panel router. Persistent cancellation state is
still represented by team_run.status + run_cancelled events.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass


@dataclass(frozen=True)
class CancelResult:
    requested: bool
    target: str
    detail: str = ""


_RUN_STREAMS: dict[str, str] = {}
_LOCK = threading.Lock()


def register_stream(run_id: str, stream_id: str) -> None:
    run = str(run_id or "").strip()
    stream = str(stream_id or "").strip()
    if not run or not stream:
        return
    with _LOCK:
        _RUN_STREAMS[run] = stream


def unregister_stream(run_id: str, stream_id: str | None = None) -> None:
    run = str(run_id or "").strip()
    if not run:
        return
    with _LOCK:
        if stream_id is not None and _RUN_STREAMS.get(run) != stream_id:
            return
        _RUN_STREAMS.pop(run, None)


def request_cancel(run_id: str) -> CancelResult:
    """Best-effort live cancellation for a TeamRun.

    Single-agent runs map to a WebUI chat stream. Orchestration runs map to the
    orchestration executor's in-memory run event. The database abort route still
    writes the authoritative northbound cancellation event.
    """
    run = str(run_id or "").strip()
    if not run:
        return CancelResult(False, "none", "empty_run_id")

    stream_id = ""
    with _LOCK:
        stream_id = _RUN_STREAMS.get(run, "")

    if stream_id:
        try:
            from api.streaming import cancel_stream

            if cancel_stream(stream_id):
                return CancelResult(True, "stream", stream_id)
        finally:
            unregister_stream(run, stream_id)

    try:
        from agent_gateway.orchestration_executor import request_cancel as request_orchestration_cancel

        if request_orchestration_cancel(run):
            return CancelResult(True, "orchestration", run)
    except Exception as exc:  # noqa: BLE001 - abort route must still mark business state.
        return CancelResult(False, "orchestration", str(exc)[:200])

    return CancelResult(False, "none", "no_live_runtime")
