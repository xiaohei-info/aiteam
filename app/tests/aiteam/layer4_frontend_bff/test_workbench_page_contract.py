from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
STATE_HELPERS_PATH = ROOT / "static" / "aiteam" / "state-helpers.js"
WORKBENCH_PAGE_PATH = ROOT / "static" / "aiteam" / "pages" / "app-workbench.js"

FORBIDDEN_RUNTIME_ROUTES = [
    "/api/chat/start",
    "/api/chat/cancel",
    "/api/session/",
    "/api/sessions",
    "/api/runtime",
    "/api/kanban",
]


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _run_workbench_page(result: dict, href: str = "http://localhost/app/workbench") -> dict:
    script = """
const fs = require('fs');
const vm = require('vm');
const stateSource = fs.readFileSync(__STATE_HELPERS_PATH__, 'utf8');
const pageSource = fs.readFileSync(__WORKBENCH_PAGE_PATH__, 'utf8');
const fetchResult = __FETCH_RESULT__;
const locationHref = __LOCATION_HREF__;
const calls = [];

global.window = {
  location: {
    href: locationHref,
    search: new URL(locationHref).search,
  },
  aiteam: {
    api: {
      getWorkbench: function () {
        calls.push('getWorkbench');
        return Promise.resolve(fetchResult);
      },
    },
  },
};
global.aiteam = global.window.aiteam;
vm.runInThisContext(stateSource, { filename: 'state-helpers.js' });
vm.runInThisContext(pageSource, { filename: 'app-workbench.js' });

(async () => {
  const container = { innerHTML: '' };
  aiteam.pages.appWorkbench.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({
    calls,
    html: container.innerHTML,
  }));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
"""
    script = script.replace("__STATE_HELPERS_PATH__", json.dumps(str(STATE_HELPERS_PATH)))
    script = script.replace("__WORKBENCH_PAGE_PATH__", json.dumps(str(WORKBENCH_PAGE_PATH)))
    script = script.replace("__FETCH_RESULT__", json.dumps(result, ensure_ascii=False))
    script = script.replace("__LOCATION_HREF__", json.dumps(href))
    completed = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def test_workbench_page_consumes_team_panel_contracts_only() -> None:
    source = _read(WORKBENCH_PAGE_PATH)
    assert "getWorkbench" in source
    assert "create_or_join_enterprise" in source
    assert "onboarding" in source
    for route in FORBIDDEN_RUNTIME_ROUTES:
        assert route not in source, f"workbench page must not reference runtime/private route {route}"


def test_workbench_page_renders_onboarding_state_when_login_flow_requests_enterprise_creation() -> None:
    result = _run_workbench_page(
        {
            "ok": True,
            "status": 200,
            "data": {
                "enterprise": None,
                "employees": [],
                "groups": [],
                "office_digest": {"online_employee_count": 0, "running_task_count": 0},
                "empty_state": {
                    "code": "NO_ENTERPRISE",
                    "title": "还没有企业空间",
                    "message": "当前还没有可用的企业工作台。",
                    "cta_label": "前往人才市场",
                    "cta_target": "/app/marketplace",
                },
            },
        },
        href="http://localhost/app/workbench?onboarding=create_or_join_enterprise",
    )

    assert result["calls"] == ["getWorkbench"]
    assert "创建或加入企业" in result["html"]
    assert "前往人才市场" in result["html"]
    assert "/app/marketplace" in result["html"]


def test_workbench_page_renders_empty_state_from_team_panel_payload() -> None:
    result = _run_workbench_page(
        {
            "ok": True,
            "status": 200,
            "data": {
                "enterprise": {"enterprise_id": "ent_1", "name": "Test Corp"},
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
    assert "先去人才市场招募第一位成员。" in result["html"]
    assert "/app/marketplace" in result["html"]


def test_workbench_page_renders_permission_denied_state_from_structured_error() -> None:
    result = _run_workbench_page(
        {
            "ok": False,
            "status": 403,
            "error": "",
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


def test_workbench_page_renders_populated_enterprise_workspace() -> None:
    result = _run_workbench_page(
        {
            "ok": True,
            "status": 200,
            "data": {
                "enterprise": {"enterprise_id": "ent_1", "name": "Test Corp"},
                "employees": [
                    {
                        "employee_id": "emp_1",
                        "display_name": "Nova",
                        "role_name": "产品策略师",
                        "status": "active",
                        "presence": "busy",
                        "last_message_preview": "正在整理企业 onboarding 清单",
                        "unread_count": 3,
                        "conversation_id": "conv_1",
                    }
                ],
                "groups": [
                    {
                        "id": "grp_1",
                        "title": "Onboarding Squad",
                        "member_count": 2,
                        "running_count": 1,
                        "last_message_preview": "同步企业初始化进度",
                        "conversation_id": "grp_conv_1",
                    }
                ],
                "office_digest": {"online_employee_count": 1, "running_task_count": 1},
            },
        }
    )

    assert "Test Corp" in result["html"]
    assert "Nova" in result["html"]
    assert "Onboarding Squad" in result["html"]
    assert "/app/chat/conv_1" in result["html"]
