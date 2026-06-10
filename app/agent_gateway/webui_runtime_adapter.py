"""WebUI runtime adapter — drives runs through the Hermes WebUI's own chat chain.

Per 业务解决方案设计 §5.2-J: "Hermes WebUI 不只是前端参考样例,而是可直接复用的
浏览器工作台与后端承载基座". The WebUI already implements the full conversation
chain — message intake, session persistence, provider/OAuth resolution,
streaming deltas, tool-call surfacing, fallback handling. This adapter reuses
that chain **non-invasively** over its public HTTP API (loopback), instead of
re-implementing an execution path:

    POST /api/session/new   {profile, model, model_provider} -> session_id
    POST /api/chat/start    {session_id, message, ...}       -> stream_id
    GET  /api/chat/stream?stream_id=...                      -> SSE

SSE named events consumed (same contract the WebUI's own frontend uses):
    token         {text}                  -> streaming delta
    tool          {name, args, preview}   -> tool call started
    tool_complete {...}                   -> tool call finished
    done          {...}                   -> turn succeeded
    (default)     {type: "error"|...}     -> turn failed

Session continuity: the returned ``session_id`` is persisted on the
RuntimeBinding so follow-up turns in the same conversation reuse the same
Hermes session (context carries across turns — 会话承接).
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Optional

logger = logging.getLogger(__name__)

_TERMINAL_ERROR_TYPES = {
    "error", "apperror", "rate_limit", "quota_exhausted", "no_response",
    "model_not_found", "auth_mismatch", "cancelled", "interrupted",
    "silent_failure",
}


def _base_url() -> str:
    host = os.getenv("HERMES_WEBUI_HOST", "127.0.0.1")
    port = os.getenv("HERMES_WEBUI_PORT", "8787")
    return f"http://{host}:{port}"


@dataclass
class TurnResult:
    success: bool
    text: str = ""
    error: str = ""
    session_id: str = ""
    tool_calls: list = field(default_factory=list)


def _post_json(path: str, body: dict, timeout: int = 30) -> dict:
    req = urllib.request.Request(
        _base_url() + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def ensure_session(profile: str, model: str = "", model_provider: str = "") -> str:
    """Create a WebUI session bound to the employee's profile."""
    body: dict = {}
    if profile and profile != "default":
        body["profile"] = profile
    if model:
        body["model"] = model
    if model_provider:
        body["model_provider"] = model_provider
    data = _post_json("/api/session/new", body)
    session = data.get("session") or {}
    session_id = str(session.get("session_id") or "")
    if not session_id:
        raise RuntimeError(f"session/new returned no session_id: {str(data)[:200]}")
    return session_id


def run_turn(
    *,
    profile: str,
    message: str,
    model: str = "",
    model_provider: str = "",
    session_id: Optional[str] = None,
    on_event: Optional[Callable[[str, dict], None]] = None,
    timeout_seconds: int = 300,
) -> TurnResult:
    """Execute one conversational turn through the WebUI chat chain.

    ``on_event(kind, payload)`` receives live ``token`` / ``tool`` /
    ``tool_complete`` events for northbound streaming. The accumulated final
    text and terminal state come back in the TurnResult.
    """
    sid = (session_id or "").strip()
    if not sid:
        sid = ensure_session(profile, model, model_provider)

    start_body: dict = {"session_id": sid, "message": message}
    if profile and profile != "default":
        start_body["profile"] = profile
    if model:
        start_body["model"] = model
    if model_provider:
        start_body["model_provider"] = model_provider

    try:
        start = _post_json("/api/chat/start", start_body)
    except urllib.error.HTTPError as exc:  # session lost/expired → one retry
        detail = exc.read().decode("utf-8", "replace")[:200]
        logger.warning("[webui-adapter] chat/start %s: %s — recreating session",
                       exc.code, detail)
        sid = ensure_session(profile, model, model_provider)
        start_body["session_id"] = sid
        start = _post_json("/api/chat/start", start_body)

    stream_id = str(start.get("stream_id") or "")
    if not stream_id:
        return TurnResult(False, error=f"chat/start returned no stream_id: {str(start)[:200]}",
                          session_id=sid)

    return _consume_stream(stream_id, sid, on_event, timeout_seconds)


def _consume_stream(stream_id: str, session_id: str,
                    on_event: Optional[Callable[[str, dict], None]],
                    timeout_seconds: int) -> TurnResult:
    url = f"{_base_url()}/api/chat/stream?stream_id={stream_id}"
    deadline = time.time() + timeout_seconds
    text_parts: list[str] = []
    tool_calls: list[dict] = []
    error = ""
    done = False

    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=timeout_seconds) as resp:
            for kind, payload in _iter_sse(resp, deadline):
                if kind == "token":
                    chunk = str(payload.get("text") or "")
                    if chunk:
                        text_parts.append(chunk)
                        _emit(on_event, "token", payload)
                elif kind == "tool":
                    tool_calls.append(payload)
                    _emit(on_event, "tool", payload)
                elif kind == "tool_complete":
                    _emit(on_event, "tool_complete", payload)
                elif kind == "done":
                    done = True
                    break
                elif kind == "message":  # default/unnamed frames carry errors
                    ptype = str(payload.get("type") or "")
                    if ptype in _TERMINAL_ERROR_TYPES:
                        error = str(payload.get("message") or payload.get("details") or ptype)
                        break
    except TimeoutError:
        error = error or f"stream timeout (> {timeout_seconds}s)"
    except OSError as exc:
        # Stream socket closed by server; treat as end-of-stream.
        if not text_parts and not done:
            error = error or f"stream connection error: {exc}"

    text = "".join(text_parts)
    if done or (text and not error):
        return TurnResult(True, text=text, session_id=session_id, tool_calls=tool_calls)
    return TurnResult(False, text=text, error=error or "stream ended without completion",
                      session_id=session_id, tool_calls=tool_calls)


def _emit(on_event, kind: str, payload: dict) -> None:
    if on_event is None:
        return
    try:
        on_event(kind, payload)
    except Exception:  # noqa: BLE001 — observer must not kill the stream
        logger.exception("[webui-adapter] on_event(%s) raised", kind)


def _iter_sse(resp, deadline: float):
    """Parse named SSE frames: yields (event_name, json_payload)."""
    event = "message"
    data_lines: list[str] = []
    for raw in resp:
        if time.time() > deadline:
            raise TimeoutError
        line = raw.decode("utf-8", "replace").rstrip("\n").rstrip("\r")
        if line.startswith("event:"):
            event = line[6:].strip() or "message"
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
        elif line == "":
            if data_lines:
                try:
                    payload = json.loads("\n".join(data_lines))
                except json.JSONDecodeError:
                    payload = {"raw": "\n".join(data_lines)}
                yield event, payload if isinstance(payload, dict) else {"value": payload}
            event = "message"
            data_lines = []
