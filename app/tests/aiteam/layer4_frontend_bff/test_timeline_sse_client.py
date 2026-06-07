from __future__ import annotations

import json
import subprocess
import uuid
from pathlib import Path

import pytest

pytest_plugins = ["tests.aiteam.layer2_team_panel.conftest"]

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
    assert "setCurrentCursor" in source
    assert "_emitStatus('catching_up')" in source
    assert "_emitStatus('reconnecting'" in source
    assert "_emitStatus('live')" in source
    assert "onReconnect" in source
    assert "source.addEventListener('timeline'" in messages_source
    assert "window.aiteam.timeline.handleEvent" in messages_source
    assert "static/aiteam/timeline-client.js?v=__WEBUI_VERSION__" in index_source


def test_timeline_client_emits_reconnect_and_catch_up_statuses():
    script = f"""
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync({json.dumps(str(_TIMELINE_CLIENT_PATH))}, 'utf8');
const events = [];
const statuses = [];
const reconnects = [];
const queue = [];
class FakeEventSource {{
  constructor(url) {{
    this.url = url;
    this.readyState = 1;
    this.listeners = {{}};
    queue.push(this);
  }}
  addEventListener(type, fn) {{
    this.listeners[type] = fn;
  }}
  close() {{
    this.readyState = 2;
  }}
  emit(type, payload) {{
    if (type === 'open' && typeof this.onopen === 'function') this.onopen(payload);
    if (type === 'error' && typeof this.onerror === 'function') this.onerror(payload);
    if (this.listeners[type]) this.listeners[type](payload);
  }}
}}
const timers = [];
const context = {{
  window: {{}},
  document: {{ baseURI: 'http://example.test/app/group/demo' }},
  EventSource: FakeEventSource,
  setTimeout(fn, ms) {{ timers.push({{ fn, ms }}); return timers.length; }},
  clearTimeout,
  console,
  URL,
}};
context.window = context;
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context);
const timeline = context.aiteam.timeline;
timeline.connect('run_demo', 5, {{
  onEvent(event) {{ events.push(event); }},
  onStatus(status) {{ statuses.push(status); }},
  onReconnect(info) {{ reconnects.push(info); return Promise.resolve({{ cursor: 9 }}); }},
}});
const first = queue.shift();
first.emit('open');
first.emit('timeline', {{ data: JSON.stringify({{ event_cursor: 8, event_type: 'task_started' }}) }});
first.emit('error');
const reconnectTimer = timers.shift();
Promise.resolve().then(() => reconnectTimer.fn()).then(() => Promise.resolve()).then(() => {{
  const second = queue.shift();
  second.emit('open');
  console.log(JSON.stringify({{
    eventCount: events.length,
    firstCursor: events[0] && events[0].event_cursor,
    statuses: statuses.map((item) => item.phase),
    reconnectCursor: reconnects[0] && reconnects[0].cursor,
    secondUrl: second && second.url,
    finalCursor: timeline.getCurrentCursor(),
  }}));
}}).catch((error) => {{
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}});
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    assert payload["eventCount"] == 1
    assert payload["firstCursor"] == 8
    assert payload["reconnectCursor"] == 8
    assert payload["statuses"] == ["connecting", "live", "reconnecting", "catching_up", "reconnecting", "live"]
    assert payload["secondUrl"].endswith("/api/team/runs/run_demo/stream?cursor=9")
    assert payload["finalCursor"] == 9


def test_timeline_client_no_raw_event_names():
    source = _read(_TIMELINE_CLIENT_PATH)
    for raw_event_name in _RAW_RUNTIME_EVENT_NAMES:
        assert raw_event_name not in source
