from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
AITEAM_STATIC = ROOT / "static" / "aiteam"
PAGES_DIR = AITEAM_STATIC / "pages"
API_CLIENT_PATH = AITEAM_STATIC / "api-client.js"
STATE_HELPERS_PATH = AITEAM_STATIC / "state-helpers.js"
PAGE_SHELL_PATH = AITEAM_STATIC / "page-shell.js"
OFFICE_MODULE_PATH = PAGES_DIR / "office.js"

FORBIDDEN_ROUTES = [
    "/api/chat/start",
    "/api/session/",
    "/api/sessions",
    "single_agent_started",
    "task_stream_delta",
    "run_completed",
]


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _run_office_module(scene_response: dict, feed_response: dict) -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
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
  {json.dumps(scene_response)},
  {json.dumps(feed_response)},
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
global.window = {{ aiteam: {{}} }};
global.aiteam = global.window.aiteam;
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(moduleSource, {{ filename: 'office.js' }});
(async () => {{
  const container = {{ innerHTML: '' }};
  aiteam.pages.office.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  if (aiteam.pages.office && aiteam.pages.office._stopPolling) {{
    aiteam.pages.office._stopPolling();
  }}
  console.log(JSON.stringify({{
    fetchCalls,
    html: container.innerHTML,
    hasHandler: !!(aiteam.pages && aiteam.pages.office),
    hasStopPolling: !!(aiteam.pages && aiteam.pages.office && aiteam.pages.office._stopPolling),
    hasRefreshData: !!(aiteam.pages && aiteam.pages.office && aiteam.pages.office._refreshData),
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


def _run_polling_lifecycle() -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(OFFICE_MODULE_PATH))}, 'utf8');
const intervals = [];
const cleared = [];
const responses = [
  {{ ok: true, status: 200, statusText: 'OK', body: {{
    summary: {{ online_employee_count: 1, busy_employee_count: 1, running_task_count: 1, queue_depth: 0, waiting_reply_count: 0 }},
    seats: [{{
      employee_id: 'emp_rex',
      display_name: 'Rex',
      role_name: '代码工程师',
      presence: {{ state: 'busy', current_task: '执行回归测试', latest_event_cursor: 12, events_url: '/api/team/runs/run_1/events?cursor=12' }},
    }}],
    generated_cursor: 12,
    refresh_hint_ms: 15000,
  }} }},
  {{ ok: true, status: 200, statusText: 'OK', body: {{
    items: [{{
      employee_id: 'emp_rex',
      employee_display_name: 'Rex',
      status: 'running',
      preview: 'Layer4 前端回归',
      latest_event_cursor: 12,
      events_url: '/api/team/runs/run_1/events?cursor=12',
      event_ts: '2026-06-05T12:34:56Z',
    }}],
    queue: {{ queued: 0, running: 1, waiting_human: 0, failed: 0 }},
    generated_cursor: 12,
    refresh_hint_ms: 15000,
  }} }},
];
global.window = {{ aiteam: {{}} }};
global.aiteam = global.window.aiteam;
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
global.fetch = async () => {{
  const next = responses.shift();
  return {{
    ok: next.ok,
    status: next.status,
    statusText: next.statusText,
    async text() {{ return JSON.stringify(next.body); }},
  }};
}};
global.setInterval = (fn, ms) => {{
  const handle = {{ fn, ms, id: intervals.length + 1 }};
  intervals.push(handle);
  return handle;
}};
global.clearInterval = (handle) => {{
  cleared.push(handle ? handle.id : null);
}};
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(moduleSource, {{ filename: 'office.js' }});
(async () => {{
  const container = {{ innerHTML: '' }};
  aiteam.pages.office.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const beforeStop = intervals.map((handle) => handle.ms);
  aiteam.pages.office._stopPolling();
  console.log(JSON.stringify({{
    beforeStop,
    cleared,
    pollTimerCleared: aiteam.pages.office._pollTimer === null,
    html: container.innerHTML,
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


def _run_viewport_controls_lifecycle() -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(OFFICE_MODULE_PATH))}, 'utf8');
const responses = [
  {{ ok: true, status: 200, statusText: 'OK', body: {{
    summary: {{ online_employee_count: 2, busy_employee_count: 1, running_task_count: 1, queue_depth: 0, waiting_reply_count: 0 }},
    seats: [{{
      employee_id: 'emp_rex',
      display_name: 'Rex',
      role_name: '代码工程师',
      presence: {{ state: 'busy', current_task: '执行回归测试', latest_event_cursor: 12, events_url: '/api/team/runs/run_1/events?cursor=12' }},
    }}],
    generated_cursor: 12,
    refresh_hint_ms: 15000,
  }} }},
  {{ ok: true, status: 200, statusText: 'OK', body: {{
    items: [{{
      employee_id: 'emp_rex',
      employee_display_name: 'Rex',
      status: 'running',
      preview: 'Layer4 前端回归',
      latest_event_cursor: 12,
      events_url: '/api/team/runs/run_1/events?cursor=12',
      event_ts: '2026-06-05T12:34:56Z',
    }}],
    queue: {{ queued: 0, running: 1, waiting_human: 0, failed: 0 }},
    generated_cursor: 12,
    refresh_hint_ms: 15000,
  }} }},
];
function makeClassList() {{
  const set = new Set();
  return {{
    contains(name) {{ return set.has(name); }},
    add(name) {{ set.add(name); }},
    remove(name) {{ set.delete(name); }},
  }};
}}
function makeButton(name) {{
  return {{
    name,
    textContent: '',
    disabled: false,
    listeners: {{}},
    addEventListener(type, handler) {{ this.listeners[type] = handler; }},
    click() {{ if (this.listeners.click) this.listeners.click({{ preventDefault() {{}} }}); }},
  }};
}}
const root = {{ style: {{}}, classList: makeClassList() }};
const fullScreenButton = makeButton('fullscreen');
const zoomInButton = makeButton('zoomIn');
const zoomOutButton = makeButton('zoomOut');
const resetButton = makeButton('reset');
const panLeftButton = makeButton('panLeft');
const panRightButton = makeButton('panRight');
const panUpButton = makeButton('panUp');
const panDownButton = makeButton('panDown');
const label = {{ textContent: '' }};
const selectorMap = {{
  '[data-office-root]': root,
  '[data-office-fullscreen]': fullScreenButton,
  '[data-office-zoom-in]': zoomInButton,
  '[data-office-zoom-out]': zoomOutButton,
  '[data-office-zoom-reset]': resetButton,
  '[data-office-pan-left]': panLeftButton,
  '[data-office-pan-right]': panRightButton,
  '[data-office-pan-up]': panUpButton,
  '[data-office-pan-down]': panDownButton,
  '[data-office-viewport-label]': label,
}};
global.window = {{ aiteam: {{}} }};
global.aiteam = global.window.aiteam;
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
global.fetch = async () => {{
  const next = responses.shift();
  return {{
    ok: next.ok,
    status: next.status,
    statusText: next.statusText,
    async text() {{ return JSON.stringify(next.body); }},
  }};
}};
global.setInterval = () => null;
global.clearInterval = () => {{}};
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(moduleSource, {{ filename: 'office.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector(selector) {{
      return selectorMap[selector] || null;
    }},
  }};
  aiteam.pages.office.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const initialTransform = root.style.transform || '';
  const initialLabel = label.textContent || '';
  zoomInButton.click();
  panRightButton.click();
  const zoomedTransform = root.style.transform || '';
  const zoomedLabel = label.textContent || '';
  resetButton.click();
  console.log(JSON.stringify({{
    html: container.innerHTML,
    initialTransform,
    initialLabel,
    zoomedTransform,
    zoomedLabel,
    resetTransform: root.style.transform || '',
    resetLabel: label.textContent || '',
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


def _run_fullscreen_shortcut_lifecycle() -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(OFFICE_MODULE_PATH))}, 'utf8');
const responses = [
  {{ ok: true, status: 200, statusText: 'OK', body: {{
    summary: {{ online_employee_count: 1, busy_employee_count: 1, running_task_count: 1, queue_depth: 0, waiting_reply_count: 0 }},
    seats: [{{
      employee_id: 'emp_rex',
      display_name: 'Rex',
      role_name: '代码工程师',
      presence: {{ state: 'busy', current_task: '执行回归测试', latest_event_cursor: 12, events_url: '/api/team/runs/run_1/events?cursor=12' }},
    }}],
    generated_cursor: 12,
    refresh_hint_ms: 15000,
  }} }},
  {{ ok: true, status: 200, statusText: 'OK', body: {{
    items: [{{
      employee_id: 'emp_rex',
      employee_display_name: 'Rex',
      status: 'running',
      preview: 'Layer4 前端回归',
      latest_event_cursor: 12,
      events_url: '/api/team/runs/run_1/events?cursor=12',
      event_ts: '2026-06-05T12:34:56Z',
    }}],
    queue: {{ queued: 0, running: 1, waiting_human: 0, failed: 0 }},
    generated_cursor: 12,
    refresh_hint_ms: 15000,
  }} }},
];
function makeClassList() {{
  const set = new Set();
  return {{
    contains(name) {{ return set.has(name); }},
    add(name) {{ set.add(name); }},
    remove(name) {{ set.delete(name); }},
  }};
}}
function makeButton(name) {{
  return {{
    name,
    textContent: '',
    disabled: false,
    listeners: {{}},
    addEventListener(type, handler) {{ this.listeners[type] = handler; }},
    click() {{ if (this.listeners.click) this.listeners.click({{ preventDefault() {{}} }}); }},
  }};
}}
const root = {{ style: {{}}, classList: makeClassList() }};
const fullScreenButton = makeButton('fullscreen');
const selectorMap = {{
  '[data-office-root]': root,
  '[data-office-fullscreen]': fullScreenButton,
}};
const documentListeners = {{}};
global.window = {{ aiteam: {{}} }};
global.document = {{
  addEventListener(type, handler) {{ documentListeners[type] = handler; }},
}};
global.aiteam = global.window.aiteam;
global.window.document = global.document;
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
global.fetch = async () => {{
  const next = responses.shift();
  return {{
    ok: next.ok,
    status: next.status,
    statusText: next.statusText,
    async text() {{ return JSON.stringify(next.body); }},
  }};
}};
global.setInterval = () => null;
global.clearInterval = () => {{}};
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(moduleSource, {{ filename: 'office.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector(selector) {{
      return selectorMap[selector] || null;
    }},
  }};
  aiteam.pages.office.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const before = fullScreenButton.textContent;
  documentListeners.keydown({{ key: 'f', target: {{ tagName: 'DIV' }}, preventDefault() {{}} }});
  const afterOpen = fullScreenButton.textContent;
  const expanded = root.classList.contains('is-fullscreen');
  documentListeners.keydown({{ key: 'F', target: {{ tagName: 'DIV' }}, preventDefault() {{}} }});
  const afterClose = fullScreenButton.textContent;
  const collapsed = !root.classList.contains('is-fullscreen');
  console.log(JSON.stringify({{
    before,
    afterOpen,
    afterClose,
    expanded,
    collapsed,
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


def _run_seat_selection_lifecycle() -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(OFFICE_MODULE_PATH))}, 'utf8');
const responses = [
  {{ ok: true, status: 200, statusText: 'OK', body: {{
    summary: {{ online_employee_count: 2, busy_employee_count: 1, running_task_count: 1, queue_depth: 0, waiting_reply_count: 0 }},
    seats: [
      {{
        employee_id: 'emp_rex',
        display_name: 'Rex',
        role_name: '代码工程师',
        presence: {{
          state: 'busy',
          current_task: '执行回归测试',
          conversation_id: 'conv_rex',
          conversation_type: 'private',
          navigation_target: '/app/chat/conv_rex',
          latest_event_cursor: 12,
          events_url: '/api/team/runs/run_1/events?cursor=12'
        }},
      }},
      {{
        employee_id: 'emp_nova',
        display_name: 'Nova',
        role_name: '数据科学家',
        presence: {{ state: 'online', current_task: '等待新任务', latest_event_cursor: 4 }},
      }},
    ],
    generated_cursor: 12,
    refresh_hint_ms: 15000,
  }} }},
  {{ ok: true, status: 200, statusText: 'OK', body: {{
    items: [{{
      employee_id: 'emp_rex',
      employee_display_name: 'Rex',
      status: 'running',
      preview: 'Layer4 前端回归',
      latest_event_cursor: 12,
      events_url: '/api/team/runs/run_1/events?cursor=12',
      event_ts: '2026-06-05T12:34:56Z',
    }}],
    queue: {{ queued: 0, running: 1, waiting_human: 0, failed: 0 }},
    generated_cursor: 12,
    refresh_hint_ms: 15000,
  }} }},
];
global.window = {{ aiteam: {{}} }};
global.aiteam = global.window.aiteam;
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
global.fetch = async () => {{
  const next = responses.shift();
  return {{
    ok: next.ok,
    status: next.status,
    statusText: next.statusText,
    async text() {{ return JSON.stringify(next.body); }},
  }};
}};
global.setInterval = () => null;
global.clearInterval = () => {{}};
function makeSeatButton(seatId) {{
  return {{
    seatId,
    listeners: {{}},
    addEventListener(type, handler) {{ this.listeners[type] = handler; }},
    getAttribute(name) {{ return name === 'data-office-seat-select' ? this.seatId : null; }},
    click() {{ if (this.listeners.click) this.listeners.click.call(this, {{ preventDefault() {{}} }}); }},
  }};
}}
const seatButtons = [makeSeatButton('emp_rex'), makeSeatButton('emp_nova')];
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(moduleSource, {{ filename: 'office.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll(selector) {{
      return selector === '[data-office-seat-select]' ? seatButtons : [];
    }},
  }};
  aiteam.pages.office.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const initialHtml = container.innerHTML;
  seatButtons[1].click();
  const afterClickHtml = container.innerHTML;
  console.log(JSON.stringify({{
    initialHtml,
    afterClickHtml,
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


def test_api_client_exposes_office_helpers() -> None:
    source = _read(API_CLIENT_PATH)
    assert "getOfficeScene()" in source
    assert "return this.get('/office/scene')" in source
    assert "getOfficeFeed()" in source
    assert "return this.get('/office/feed')" in source


def test_page_shell_routes_office_to_module() -> None:
    source = _read(PAGE_SHELL_PATH)
    assert "'/app/office'" in source or '"/app/office"' in source
    assert "office.js" in source
    assert "aiteam.pages.office" in source


def test_office_module_exists() -> None:
    assert OFFICE_MODULE_PATH.exists(), f"Missing office module: {OFFICE_MODULE_PATH}"


def test_office_module_uses_team_panel_office_routes() -> None:
    source = _read(OFFICE_MODULE_PATH)
    assert "/api/team/office/scene" in source or "getOfficeScene" in source
    assert "/api/team/office/feed" in source or "getOfficeFeed" in source
    assert "aiteam-office__stage" in source
    assert "data-office-fullscreen" in source
    assert "data-office-zoom-in" in source
    assert "data-office-pan-right" in source
    assert "企业办公室" in source
    for forbidden in FORBIDDEN_ROUTES:
        assert forbidden not in source


def test_office_module_renders_error_when_office_api_unavailable() -> None:
    result = _run_office_module(
        {"ok": False, "status": 501, "body": {"error": "Not Implemented"}},
        {"ok": False, "status": 501, "body": {"error": "Not Implemented"}},
    )
    assert result["hasHandler"] is True
    assert result["hasStopPolling"] is True
    assert result["hasRefreshData"] is True
    assert result["fetchCalls"] == [
        {"url": "/api/team/office/scene", "method": "GET"},
        {"url": "/api/team/office/feed", "method": "GET"},
    ]
    assert "Not Implemented" in result["html"]


def test_office_module_renders_empty_scene_when_scene_is_empty() -> None:
    result = _run_office_module(
        {
            "ok": True,
            "status": 200,
            "body": {
                "summary": {
                    "online_employee_count": 0,
                    "busy_employee_count": 0,
                    "running_task_count": 0,
                    "queue_depth": 0,
                    "waiting_reply_count": 0,
                },
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
    assert "企业办公室" in result["html"]
    assert "data-office-root" in result["html"]
    assert "当前暂无运行中的任务队列" in result["html"]
    assert "刷新间隔: 10.0s" in result["html"]


def test_office_module_renders_live_scene_for_canonical_backend_payload() -> None:
    result = _run_office_module(
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
                            "conversation_type": "private",
                            "navigation_target": "/app/chat/conv_rex",
                            "latest_event_cursor": 18,
                            "events_url": "/api/team/runs/run_rex/events?cursor=18",
                        },
                    },
                    {
                        "employee_id": "emp_nova",
                        "display_name": "Nova",
                        "role_name": "数据科学家",
                        "presence": {
                            "state": "online",
                            "current_task": "等待新任务",
                            "latest_event_cursor": 0,
                        },
                    },
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
                        "employee_id": "emp_rex",
                        "employee_display_name": "Rex",
                        "status": "running",
                        "preview": "执行回归测试",
                        "detail": "正在同步 Layer4 回归结果",
                        "conv_type": "private",
                        "navigation_target": "/app/chat/conv_rex",
                        "conversation_id": "conv_rex",
                        "latest_event_cursor": 18,
                        "events_url": "/api/team/runs/run_rex/events?cursor=18",
                        "event_ts": "2026-06-05T12:34:56Z",
                    },
                    {
                        "employee_id": "emp_rex",
                        "employee_display_name": "Rex",
                        "status": "completed",
                        "preview": "整理回归结论",
                        "detail": "已输出结论摘要",
                        "conv_type": "private",
                        "navigation_target": "/app/chat/conv_rex",
                        "conversation_id": "conv_rex",
                        "event_ts": "2026-06-05T11:34:56Z",
                    },
                ],
                "queue": {"queued": 0, "running": 1, "waiting_human": 0, "failed": 0},
                "generated_cursor": 18,
                "refresh_hint_ms": 15000,
            },
        },
    )
    assert "Rex" in result["html"]
    assert "Nova" in result["html"]
    assert "执行回归测试" in result["html"]
    assert "企业办公室" in result["html"]
    assert "全屏查看" in result["html"]
    assert "aiteam-office__stage" in result["html"]
    assert "data-office-seat-select" in result["html"]
    assert "任务队列" in result["html"]
    assert "员工详情" in result["html"]
    assert "当前任务" in result["html"]
    assert "最近对话" in result["html"]
    assert "历史任务" in result["html"]
    assert "整理回归结论" in result["html"]
    assert "场景游标: 18" in result["html"]
    assert "活动游标: 18" in result["html"]
    assert "cursor #18" in result["html"] or ">#18<" in result["html"]
    assert "刷新间隔: 15.0s" in result["html"]


def test_office_module_handles_empty_feed_without_preview() -> None:
    result = _run_office_module(
        {
            "ok": True,
            "status": 200,
            "body": {
                "summary": {
                    "online_employee_count": 1,
                    "busy_employee_count": 0,
                    "running_task_count": 0,
                    "queue_depth": 0,
                    "waiting_reply_count": 0,
                },
                "seats": [
                    {
                        "employee_id": "emp_orion",
                        "display_name": "Orion",
                        "role_name": "研究员",
                        "presence": {
                            "state": "online",
                            "current_task": "等待新任务",
                            "latest_event_cursor": 0,
                        },
                    }
                ],
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
    assert "Orion" in result["html"]
    assert "企业办公室" in result["html"]
    assert "当前暂无运行中的任务队列" in result["html"]


def test_office_module_polling_lifecycle_uses_refresh_hint() -> None:
    result = _run_polling_lifecycle()
    assert result["beforeStop"] == [15000]
    assert result["cleared"] == [1]
    assert result["pollTimerCleared"] is True
    assert "企业办公室" in result["html"]
    assert "全屏查看" in result["html"]
    assert "刷新间隔: 15.0s" in result["html"]


def test_office_module_supports_zoom_pan_and_viewport_reset() -> None:
    result = _run_viewport_controls_lifecycle()
    assert "缩小" in result["html"]
    assert "放大" in result["html"]
    assert "重置视角" in result["html"]
    assert result["initialTransform"] == "translate(0px, 0px) scale(1)"
    assert result["initialLabel"] == "100%"
    assert result["zoomedTransform"] == "translate(80px, 0px) scale(1.15)"
    assert result["zoomedLabel"] == "115%"
    assert result["resetTransform"] == "translate(0px, 0px) scale(1)"
    assert result["resetLabel"] == "100%"


def test_office_module_supports_f_shortcut_for_fullscreen_toggle() -> None:
    result = _run_fullscreen_shortcut_lifecycle()
    assert result["before"] == "全屏查看"
    assert result["afterOpen"] == "退出全屏"
    assert result["afterClose"] == "全屏查看"
    assert result["expanded"] is True
    assert result["collapsed"] is True


def test_office_module_renders_queue_digest_and_recent_activity_log() -> None:
    result = _run_office_module(
        {
            "ok": True,
            "status": 200,
            "body": {
                "summary": {
                    "online_employee_count": 2,
                    "busy_employee_count": 1,
                    "running_task_count": 1,
                    "queue_depth": 2,
                    "waiting_reply_count": 1,
                },
                "seats": [
                    {
                        "employee_id": "emp_rex",
                        "display_name": "Rex",
                        "role_name": "代码工程师",
                        "presence": {
                            "state": "busy",
                            "current_task": "执行回归测试",
                            "latest_event_cursor": 21,
                            "events_url": "/api/team/runs/run_rex/events?cursor=21",
                        },
                    }
                ],
                "generated_cursor": 21,
                "refresh_hint_ms": 12000,
            },
        },
        {
            "ok": True,
            "status": 200,
            "body": {
                "items": [
                    {
                        "employee_id": "emp_rex",
                        "employee_display_name": "Rex",
                        "status": "running",
                        "preview": "执行回归测试",
                        "detail": "正在同步 Layer4 回归结果",
                        "conv_type": "private",
                        "navigation_target": "/app/chat/conv_rex",
                        "conversation_id": "conv_rex",
                        "latest_event_cursor": 21,
                        "events_url": "/api/team/runs/run_rex/events?cursor=21",
                        "event_ts": "2026-06-05T12:34:56Z",
                    }
                ],
                "queue": {"queued": 2, "running": 1, "waiting_human": 1, "failed": 0},
                "generated_cursor": 21,
                "refresh_hint_ms": 12000,
            },
        },
    )
    assert "队列统计" in result["html"]
    assert "排队" in result["html"] and ">2<" in result["html"]
    assert "运行中" in result["html"] and ">1<" in result["html"]
    assert "待人工" in result["html"]
    assert "失败" in result["html"] and ">0<" in result["html"]
    assert "最新活动" in result["html"]
    assert "2026-06-05T12:34:56Z" in result["html"]
    assert "正在同步 Layer4 回归结果" in result["html"]
    assert 'href="/app/chat/conv_rex"' in result["html"]


def test_office_module_routes_group_context_to_group_page() -> None:
    result = _run_office_module(
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
                            "current_task": "处理预算评审群消息",
                            "conversation_id": "group_budget",
                            "conversation_type": "group",
                            "navigation_target": "/app/group/group_budget",
                            "latest_event_cursor": 18,
                            "events_url": "/api/team/runs/run_group/events?cursor=18",
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
                        "employee_id": "emp_rex",
                        "employee_display_name": "Rex",
                        "status": "running",
                        "preview": "预算评审群",
                        "detail": "正在同步多人协作结论",
                        "conv_type": "group",
                        "conversation_id": "group_budget",
                        "navigation_target": "/app/group/group_budget",
                        "latest_event_cursor": 18,
                        "events_url": "/api/team/runs/run_group/events?cursor=18",
                        "event_ts": "2026-06-05T12:34:56Z",
                    }
                ],
                "queue": {"queued": 0, "running": 1, "waiting_human": 0, "failed": 0},
                "generated_cursor": 18,
                "refresh_hint_ms": 15000,
            },
        },
    )
    assert 'href="/app/group/group_budget"' in result["html"]
    assert 'href="/app/chat/group_budget"' not in result["html"]


def test_office_module_switches_detail_panel_when_selecting_another_seat() -> None:
    result = _run_seat_selection_lifecycle()
    assert "员工详情" in result["initialHtml"]
    assert "历史任务" in result["initialHtml"]
    assert "Rex" in result["initialHtml"]
    assert "执行回归测试" in result["initialHtml"]
    assert 'href="/app/chat/conv_rex"' in result["initialHtml"]
    assert "Nova" in result["afterClickHtml"]
    assert "数据科学家" in result["afterClickHtml"]
    assert "等待新任务" in result["afterClickHtml"]
    assert "暂无历史任务" in result["afterClickHtml"]
