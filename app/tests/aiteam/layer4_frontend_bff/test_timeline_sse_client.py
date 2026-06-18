from __future__ import annotations

import json
import subprocess
import uuid
from pathlib import Path

import pytest

from tests.aiteam.layer2_team_panel.test_team_api_contracts import (  # noqa: E402
    _get_raw,
    _handler_content_type,
    _handler_text,
    _post,
)

_APP_ROOT = Path(__file__).resolve().parents[3]
_TIMELINE_CLIENT_PATH = _APP_ROOT / "static" / "aiteam" / "timeline-client.js"
_MESSAGES_PATH = _APP_ROOT / "static" / "messages.js"
_INDEX_PATH = _APP_ROOT / "static" / "index.html"
_RAW_RUNTIME_EVENT_NAMES = (
    "single_agent_started",
    "task_stream_delta",
    "run_completed",
)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_sse_stream_emits_timeline_events(seeded_enterprise, db_conn):
    emp_id = seeded_enterprise["employee_id"]
    enterprise_id = seeded_enterprise["enterprise_id"]
    _, run_resp = _post(
        "/api/team/runs",
        {
            "employee_id": emp_id,
            "conversation_id": seeded_enterprise["conversation_id"],
            "message": {"text": "Hello"},
        },
    )
    run_id = run_resp["run_id"]

    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id, employee_id, preview_text, payload_json) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                f"evt_{uuid.uuid4().hex[:8]}",
                enterprise_id,
                run_id,
                1,
                "run_started",
                "session",
                "sess_test",
                emp_id,
                "Starting...",
                json.dumps({"message_id": "msg_001"}),
            ),
        )
        db_conn.commit()
    finally:
        cur.close()

    handler = _get_raw(f"/api/team/runs/{run_id}/stream?cursor=0")
    assert handler.status == 200
    content_type = _handler_content_type(handler)
    assert content_type is not None and "text/event-stream" in content_type

    body_text = _handler_text(handler)
    assert "event: timeline" in body_text

    frames = [frame for frame in body_text.rstrip("\n").split("\n\n") if frame]
    assert frames, "Expected at least one SSE frame"
    payload = json.loads(frames[0].split("\n", 1)[1][len("data: "):])
    assert payload["run_id"] == run_id
    assert payload["event_cursor"] == 1
    assert payload["event_type"] == "run_started"


def test_timeline_client_uses_cursor_for_reconnect():
    source = _read(_TIMELINE_CLIENT_PATH)
    messages_source = _read(_MESSAGES_PATH)
    index_source = _read(_INDEX_PATH)

    assert "new EventSource" in source
    assert "addEventListener('timeline'" in source
    assert "stream?cursor=${this._normalizeCursor(cursor)}" in source
    assert "parsed && parsed.event_cursor" in source
    assert "setTimeout" in source
    assert "getCurrentCursor" in source
    assert "const resumeCursor = this._cursor;" in source
    assert "this._onReconnect(resumeCursor)" in source
    assert "this._onOpen(resumeCursor)" in source
    assert "window.aiteam.timeline.handleEvent" in messages_source
    assert "static/aiteam/timeline-client.js?v=__WEBUI_VERSION__" in index_source


def test_timeline_client_no_raw_event_names():
    source = _read(_TIMELINE_CLIENT_PATH)
    for raw_event_name in _RAW_RUNTIME_EVENT_NAMES:
        assert raw_event_name not in source


def _run_timeline_client_js(script_body: str) -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync({json.dumps(str(_TIMELINE_CLIENT_PATH))}, 'utf8');

const sources = [];
global.EventSource = class EventSource {{
  constructor(url) {{
    this.url = url;
    this.listeners = {{}};
    this.onopen = null;
    this.onerror = null;
    this.closed = false;
    sources.push(this);
  }}
  addEventListener(name, handler) {{ this.listeners[name] = handler; }}
  emit(name, data) {{ if (this.listeners[name]) this.listeners[name]({{ data }}); }}
  close() {{ this.closed = true; }}
}};
global.window = {{ location: {{ href: 'http://localhost/app/chat/x' }} }};
global.document = {{ baseURI: 'http://localhost/app/chat/x' }};
global.setTimeout = (fn) => 0;   // never auto-reconnect during the test
global.clearTimeout = () => {{}};

vm.runInThisContext(source, {{ filename: 'timeline-client.js' }});
const timeline = global.window.aiteam.timeline;

const result = {{}};
{script_body}
console.log(JSON.stringify(result));
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def test_timeline_client_dispatches_stream_end_to_callback():
    # The live SSE stream signals completion with a named `stream_end` frame
    # (it never emits a terminal timeline event), so the client must surface it
    # via an onStreamEnd callback and stop reconnecting.
    result = _run_timeline_client_js(
        """
let streamEndCalls = 0;
timeline.connect('run_x', 0, function () {}, {
  onStreamEnd: function () { streamEndCalls += 1; },
});
sources[0].emit('stream_end', '{}');
result.streamEndCalls = streamEndCalls;
result.sourceClosed = sources[0].closed;
result.runIdCleared = timeline._runId === null;
"""
    )
    assert result["streamEndCalls"] == 1
    assert result["sourceClosed"] is True
    assert result["runIdCleared"] is True


def test_timeline_client_stream_end_is_safe_without_callback():
    # Older callers connect without onStreamEnd; a stream_end frame must not throw.
    result = _run_timeline_client_js(
        """
timeline.connect('run_y', 0, function () {}, {});
sources[0].emit('stream_end', '{}');
result.ok = true;
result.sourceClosed = sources[0].closed;
"""
    )
    assert result["ok"] is True
    assert result["sourceClosed"] is True
