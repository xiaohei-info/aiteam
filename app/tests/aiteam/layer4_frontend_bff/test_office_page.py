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
    assert "预览模式 · 等待 /api/team/office/* 聚合接口" in result["html"]
    assert "办公室动态" in result["html"]
    assert "任务队列" in result["html"]
    assert "工位详情" in result["html"]


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
    assert "预览模式 · 等待 /api/team/office/* 聚合接口" in result["html"]
    assert "Rex" in result["html"]
    assert "执行自动化回归测试" in result["html"]
    assert "点击工位查看详情" in result["html"]


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
    assert "Rex" in result["html"]
    assert "Nova" in result["html"]
    assert "执行回归测试" in result["html"]
    assert "办公室动态" in result["html"]
    assert "2 位在线" in result["html"]
    assert "1 个任务执行中" in result["html"]
    assert "任务队列" in result["html"]
    assert "状态统计" in result["html"]
    assert "实时日志" in result["html"]
    assert "工位详情" in result["html"]
    assert "预览模式" not in result["html"]


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
    assert "当前暂无运行中的任务队列" in result["html"]
    assert "预览模式" not in result["html"]


def test_office_module_polling_lifecycle_uses_refresh_hint() -> None:
    result = _run_polling_lifecycle()
    assert result["beforeStop"] == [15000]
    assert result["cleared"] == [1]
    assert result["pollTimerCleared"] is True
    assert "全屏查看" in result["html"]
    assert "任务队列" in result["html"]
