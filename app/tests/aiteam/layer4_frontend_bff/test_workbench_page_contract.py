from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
API_CLIENT_PATH = ROOT / "static" / "aiteam" / "api-client.js"
STATE_HELPERS_PATH = ROOT / "static" / "aiteam" / "state-helpers.js"
WORKBENCH_PAGE_PATH = ROOT / "static" / "aiteam" / "pages" / "app-workbench.js"


def _source() -> str:
    return WORKBENCH_PAGE_PATH.read_text(encoding="utf-8")


def _run_page(result: dict, search: str = "") -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(WORKBENCH_PAGE_PATH))}, 'utf8');
const fetchCalls = [];
const queuedResult = {json.dumps(result, ensure_ascii=False)};

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
global.fetch = async (url, options) => {{
  fetchCalls.push({{ url, method: options.method }});
  return {{
    ok: queuedResult.ok,
    status: queuedResult.status,
    statusText: queuedResult.ok ? 'OK' : 'Error',
    async text() {{ return JSON.stringify(queuedResult.data); }},
  }};
}};
global.window = {{
  aiteam: {{}},
  location: {{
    href: 'http://localhost/app/workbench{search}',
    pathname: '/app/workbench',
    search: {json.dumps(search)},
  }},
}};
global.aiteam = global.window.aiteam;
global.document = {{
  baseURI: 'http://localhost/app/workbench',
}};

vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(moduleSource, {{ filename: 'app-workbench.js' }});

(async () => {{
  const container = {{ innerHTML: '' }};
  aiteam.pages.appWorkbench.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{
    fetchCalls,
    html: container.innerHTML,
  }}));
}})().catch((error) => {{
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}});
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    return json.loads(completed.stdout)


def test_workbench_page_declares_onboarding_empty_permission_and_populated_states() -> None:
    source = _source()
    assert "create_or_join_enterprise" in source
    assert "renderEmpty" in source
    assert "handleApiResult" in source
    assert "员工私聊入口" in source


def test_workbench_page_fetches_only_team_panel_workbench_contract() -> None:
    result = _run_page(
        {
            "ok": True,
            "status": 200,
            "data": {
                "enterprise": {"enterprise_id": "ent_001", "name": "Test Corp"},
                "employees": [],
                "groups": [],
                "office_digest": {"online_employee_count": 0, "running_task_count": 0},
            },
        }
    )
    assert result["fetchCalls"] == [{"url": "/api/team/workbench", "method": "GET"}]


def test_workbench_page_renders_explicit_onboarding_state() -> None:
    result = _run_page(
        {
            "ok": True,
            "status": 200,
            "data": {
                "enterprise": {"enterprise_id": "ent_001", "name": "Test Corp"},
                "employees": [],
                "groups": [],
                "office_digest": {"online_employee_count": 0, "running_task_count": 0},
            },
        },
        "?onboarding=create_or_join_enterprise",
    )
    assert "create_or_join_enterprise" in result["html"]
    assert "创建或加入企业" in result["html"]


def test_workbench_page_renders_empty_state_from_backend_contract() -> None:
    result = _run_page(
        {
            "ok": True,
            "status": 200,
            "data": {
                "enterprise": {"enterprise_id": "ent_001", "name": "Test Corp"},
                "employees": [],
                "groups": [],
                "office_digest": {"online_employee_count": 0, "running_task_count": 0},
                "empty_state": {
                    "code": "NO_EMPLOYEES",
                    "title": "你还没有数字员工",
                    "message": "先去人才市场招募第一位成员。",
                    "cta_label": "前往人才市场",
                    "cta_target": "/app/marketplace",
                },
            },
        }
    )
    assert "你还没有数字员工" in result["html"]
    assert "/app/marketplace" in result["html"]


def test_workbench_page_renders_permission_denied_state() -> None:
    result = _run_page(
        {
            "ok": False,
            "status": 403,
            "data": {
                "error": {
                    "code": "PERMISSION_DENIED",
                    "message": "当前账号没有查看工作台的权限",
                    "retryable": False,
                }
            },
        }
    )
    assert "aiteam-state-denied" in result["html"]
    assert "当前账号没有查看工作台的权限" in result["html"]


def test_workbench_page_renders_populated_state() -> None:
    result = _run_page(
        {
            "ok": True,
            "status": 200,
            "data": {
                "enterprise": {"enterprise_id": "ent_001", "name": "Test Corp"},
                "employees": [
                    {
                        "employee_id": "emp_001",
                        "display_name": "销售助理",
                        "role_name": "销售",
                        "status": "active",
                        "presence": "busy",
                        "unread_count": 2,
                        "conversation_id": "conv_001",
                        "last_message_preview": "跟进客户",
                    }
                ],
                "groups": [
                    {
                        "conversation_id": "grp_001",
                        "title": "增长协作组",
                        "member_count": 3,
                        "running_count": 1,
                        "last_message_preview": "同步投放计划",
                    }
                ],
                "office_digest": {"online_employee_count": 1, "running_task_count": 1},
            },
        }
    )
    assert "员工私聊入口" in result["html"]
    assert "增长协作组" in result["html"]
