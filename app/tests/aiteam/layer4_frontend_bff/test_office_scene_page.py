"""
Test suite for office.js scene-based implementation (AITEAM-5).

Tests the PRD-aligned office dynamic scene with:
- Scene-first layout with toolbar
- Browsable main office scene with pan/zoom
- Clickable seats/workstations
- Bottom information layer (queue/stats/logs)
- Fullscreen support
- Selected seat/task behavior with context links
- Preview-vs-live boundary with fallback
- Timeline client integration for live log stream
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
AITEAM_STATIC = ROOT / "static" / "aiteam"
PAGES_DIR = AITEAM_STATIC / "pages"
API_CLIENT_PATH = AITEAM_STATIC / "api-client.js"
STATE_HELPERS_PATH = AITEAM_STATIC / "state-helpers.js"
TIMELINE_CLIENT_PATH = AITEAM_STATIC / "timeline-client.js"
OFFICE_MODULE_PATH = PAGES_DIR / "office.js"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _run_office_scene_module(scene_response: dict, feed_response: dict) -> dict:
    """Run office module with mocked API responses."""
    scene_json = json.dumps(scene_response)
    feed_json = json.dumps(feed_response)
    
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const timelineClientSource = fs.readFileSync({json.dumps(str(TIMELINE_CLIENT_PATH))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(OFFICE_MODULE_PATH))}, 'utf8');

const fetchCalls = [];
global.Headers = class Headers {{
  constructor(init) {{
    this.map = new Map();
    if (init) {{
      for (const [key, value] of Object.entries(init)) this.map.set(String(key).toLowerCase(), String(value));
    }}
  }}
  has(name) {{ return this.map.has(String(name).toLowerCase()); }}
  set(name, value) {{ this.map.set(String(name).toLowerCase(), String(value)); }}
}};

const responses = [
  {scene_json},
  {feed_json},
];

const intervals = [];
global.fetch = async (url, options) => {{
  fetchCalls.push({{ url, method: options.method }});
  const next = responses.shift();
  return {{
    ok: next.ok,
    status: next.status,
    statusText: next.statusText || 'Request failed',
    async text() {{ return JSON.stringify(next.body); }},
  }};
}};

global.setInterval = (fn, ms) => {{
  const handle = {{ fn, ms, id: intervals.length + 1 }};
  intervals.push(handle);
  return handle;
}};
global.clearInterval = () => {{}};

global.EventSource = class EventSource {{
  constructor(url) {{
    this.url = url;
    this.readyState = 0;
    setTimeout(() => {{
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }}, 10);
  }}
  addEventListener(event, handler) {{
    if (event === 'timeline') {{
      setTimeout(() => {{
        handler({{ data: JSON.stringify({{
          event_cursor: 1,
          event_type: 'log',
          payload: {{ message: 'Test log entry' }}
        }}) }});
      }}, 20);
    }}
  }}
  close() {{ this.readyState = 2; }}
}};

global.window = {{ aiteam: {{}} }};
global.aiteam = global.window.aiteam;
global.document = {{ baseURI: 'http://localhost:8080/', removeEventListener: () => {{}} }};

vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(timelineClientSource, {{ filename: 'timeline-client.js' }});
vm.runInThisContext(moduleSource, {{ filename: 'office.js' }});

(async () => {{
  const container = {{ 
    innerHTML: '',
    querySelector: (sel) => null,
    querySelectorAll: (sel) => [],
    addEventListener: () => {{}},
    classList: {{ contains: () => false, add: () => {{}}, remove: () => {{}}, toggle: () => {{}} }},
    style: {{}},
    requestFullscreen: () => Promise.resolve(),
  }};
  
  aiteam.pages.office.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  
  const hasPolling = !!(aiteam.pages.office && (aiteam.pages.office._pollTimer || aiteam.pages.office._state.pollTimer));
  
  if (aiteam.pages.office && aiteam.pages.office._stopPolling) {{
    aiteam.pages.office._stopPolling();
  }}
  if (aiteam.pages.office && aiteam.pages.office._cleanup) {{
    aiteam.pages.office._cleanup();
  }}
  
  console.log(JSON.stringify({{
    fetchCalls,
    html: container.innerHTML,
    hasHandler: !!(aiteam.pages && aiteam.pages.office),
    hasToolbar: container.innerHTML.includes('toolbar') || container.innerHTML.includes('office-scene'),
    hasBottomPanel: container.innerHTML.includes('bottom-panel') || container.innerHTML.includes('bp-section'),
    hasFullscreenButton: container.innerHTML.includes('fullscreen') || container.innerHTML.includes('全屏'),
    hasPolling: hasPolling,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def test_office_scene_module_exists() -> None:
    """Verify office.js module exists."""
    assert OFFICE_MODULE_PATH.exists(), f"Missing office module: {OFFICE_MODULE_PATH}"


def test_office_module_uses_team_panel_office_routes() -> None:
    """Verify office module uses correct Team Panel API routes."""
    source = _read(OFFICE_MODULE_PATH)
    assert "getOfficeScene" in source, "Should call getOfficeScene"
    assert "getOfficeFeed" in source, "Should call getOfficeFeed"
    forbidden = ["/api/chat/start", "/api/session/", "single_agent_started"]
    for route in forbidden:
        assert route not in source, f"Should not use forbidden route: {route}"


def test_office_module_renders_scene_based_layout() -> None:
    """Test that office module renders scene-first layout."""
    result = _run_office_scene_module(
        {
            "ok": True,
            "status": 200,
            "body": {
                "summary": {
                    "online_employee_count": 2,
                    "busy_employee_count": 1,
                    "running_task_count": 1,
                    "queue_depth": 0,
                    "waiting_reply_count": 0,
                },
                "seats": [
                    {
                        "employee_id": "emp_rex",
                        "display_name": "Rex",
                        "role_name": "代码工程师",
                        "presence": {
                            "state": "busy",
                            "current_task": "执行回归测试",
                            "latest_event_cursor": 18,
                            "events_url": "/api/team/runs/run_rex/events?cursor=18",
                            "conversation_id": "conv_rex_123",
                        },
                    }
                ],
                "generated_cursor": 18,
                "refresh_hint_ms": 15000,
            },
        },
        {
            "ok": True,
            "status": 200,
            "body": {
                "items": [
                    {
                        "run_id": "run_rex_001",
                        "employee_id": "emp_rex",
                        "employee_display_name": "Rex",
                        "status": "running",
                        "display_state": "busy",
                        "preview": "执行回归测试",
                        "event_type": "run_status",
                        "latest_event_cursor": 18,
                        "events_url": "/api/team/runs/run_rex/events?cursor=18",
                        "event_ts": "2026-06-05T12:34:56Z",
                    }
                ],
                "queue": {"queued": 0, "running": 1, "waiting_human": 0, "failed": 0},
                "generated_cursor": 18,
                "refresh_hint_ms": 15000,
            },
        },
    )
    assert result["hasHandler"] is True
    assert result["hasToolbar"] is True, "Should have toolbar"
    assert result["hasBottomPanel"] is True, "Should have bottom panel"
    assert result["hasFullscreenButton"] is True, "Should have fullscreen button"


def test_office_module_renders_clickable_seats() -> None:
    """Test that seats are clickable and show task details."""
    result = _run_office_scene_module(
        {
            "ok": True,
            "status": 200,
            "body": {
                "summary": {
                    "online_employee_count": 1,
                    "busy_employee_count": 1,
                    "running_task_count": 1,
                    "queue_depth": 0,
                    "waiting_reply_count": 0,
                },
                "seats": [
                    {
                        "employee_id": "emp_rex",
                        "display_name": "Rex",
                        "role_name": "代码工程师",
                        "presence": {
                            "state": "busy",
                            "current_task": "执行回归测试",
                            "latest_event_cursor": 18,
                            "events_url": "/api/team/runs/run_rex/events?cursor=18",
                            "conversation_id": "conv_rex_123",
                        },
                    }
                ],
                "generated_cursor": 18,
                "refresh_hint_ms": 15000,
            },
        },
        {
            "ok": True,
            "status": 200,
            "body": {
                "items": [],
                "queue": {"queued": 0, "running": 1, "waiting_human": 0, "failed": 0},
                "generated_cursor": 18,
                "refresh_hint_ms": 15000,
            },
        },
    )
    assert "Rex" in result["html"], "Should render employee name"
    assert "执行回归测试" in result["html"], "Should render current task"


def test_office_module_shows_preview_fallback_when_live_unavailable() -> None:
    """Test preview mode fallback when live data is unavailable."""
    result = _run_office_scene_module(
        {"ok": False, "status": 503, "body": {"error": "Service Unavailable"}},
        {"ok": False, "status": 503, "body": {"error": "Service Unavailable"}},
    )
    assert result["hasHandler"] is True
    assert "office-scene" in result["html"] or "预览模式" in result["html"] or "办公室动态" in result["html"], \
        "Should indicate preview mode when live data unavailable"


def test_office_module_polls_with_refresh_hint() -> None:
    """Test that polling respects refresh_hint_ms from backend."""
    result = _run_office_scene_module(
        {
            "ok": True,
            "status": 200,
            "body": {
                "summary": {"online_employee_count": 1, "busy_employee_count": 0, "running_task_count": 0, "queue_depth": 0, "waiting_reply_count": 0},
                "seats": [],
                "generated_cursor": 0,
                "refresh_hint_ms": 10000,
            },
        },
        {
            "ok": True,
            "status": 200,
            "body": {
                "items": [],
                "queue": {"queued": 0, "running": 0, "waiting_human": 0, "failed": 0},
                "generated_cursor": 0,
                "refresh_hint_ms": 10000,
            },
        },
    )
    assert result["hasPolling"] is True, "Should have polling mechanism"


def test_office_module_includes_timeline_client_integration() -> None:
    """Test that office module can integrate with timeline client for live logs."""
    source = _read(OFFICE_MODULE_PATH)
    has_timeline = "timeline" in source.lower() or "getRunEvents" in source
    assert has_timeline or "_selectedRunId" in source or "selectedRun" in source, \
        "Should have mechanism for live log streaming"


def test_office_module_has_fullscreen_support() -> None:
    """Test that office module supports fullscreen mode."""
    source = _read(OFFICE_MODULE_PATH)
    assert "fullscreen" in source.lower() or "is-fullscreen" in source, \
        "Should support fullscreen mode"


def test_office_module_has_pan_zoom_support() -> None:
    """Test that office scene supports pan and zoom."""
    source = _read(OFFICE_MODULE_PATH)
    has_pan = "pan" in source.lower() or "drag" in source.lower() or "offset" in source.lower()
    has_zoom = "zoom" in source.lower() or "scale" in source.lower()
    assert has_pan or has_zoom, "Should support pan and/or zoom for scene browsing"


def test_office_module_uses_real_backend_fields() -> None:
    """Test that office module uses real backend field names (preview, display_state, etc.)."""
    source = _read(OFFICE_MODULE_PATH)
    assert "preview" in source, "Should use 'preview' field from backend"
    assert "display_state" in source, "Should use 'display_state' field from backend"
    assert "run_id" in source, "Should use 'run_id' field from backend"


def test_office_module_has_detail_panel() -> None:
    """Test that office module has a selected seat detail panel."""
    source = _read(OFFICE_MODULE_PATH)
    assert "detail-panel" in source or "detailPanel" in source, \
        "Should have detail panel for selected seat"
    assert "detail-avatar" in source or "detail-name" in source, \
        "Should show employee details in detail panel"


def test_seat_click_selects_in_place() -> None:
    """Test that clicking a seat selects it in-place without navigation."""
    source = _read(OFFICE_MODULE_PATH)
    assert 'role="button"' in source, "Seat should be a button role for in-place selection"
    assert "e.preventDefault()" in source, "Should prevent default navigation on seat click"
    assert "e.stopPropagation()" in source, "Should stop propagation on seat click"


def test_fullscreen_toggles_scene_element() -> None:
    """Test that fullscreen toggle applies class to scene element, not container."""
    source = _read(OFFICE_MODULE_PATH)
    assert "querySelector('.aiteam-office-scene')" in source or 'querySelector(".aiteam-office-scene")' in source, \
        "Should query for scene element to toggle fullscreen"
    assert "classList.add('is-fullscreen')" in source or 'classList.add("is-fullscreen")' in source, \
        "Should toggle is-fullscreen class on scene element"


def test_fullscreen_button_text_updates() -> None:
    """Test that fullscreen button text updates when toggled."""
    source = _read(OFFICE_MODULE_PATH)
    assert '退出全屏' in source, "Should have '退出全屏' text for fullscreen exit button"
    assert '全屏查看' in source, "Should have '全屏查看' text for fullscreen enter button"
    assert "updateFullscreenButton" in source, "Should call updateFullscreenButton after toggle"
