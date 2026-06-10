from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WORKBENCH_MODULE_PATH = ROOT / "static" / "aiteam" / "pages" / "app-workbench.js"


def _run_workbench(payload: dict, *, search: str = "") -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(WORKBENCH_MODULE_PATH))}, 'utf8');
global.window = {{
  location: {{
    search: {json.dumps(search)},
  }},
  aiteam: {{
    util: {{
      escapeHtml(value) {{
        return String(value == null ? '' : value);
      }},
    }},
    pages: {{}},
    states: {{
      renderEmpty(container, message, actionHtml) {{
        container.innerHTML = '<div data-state-empty="1"><p>' + message + '</p>' + (actionHtml || '') + '</div>';
      }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'app-workbench.js' }});
const container = {{ innerHTML: '' }};
aiteam.pages.appWorkbench.render(container, {json.dumps(payload, ensure_ascii=False)});
console.log(JSON.stringify({{ html: container.innerHTML }}));
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def _run_workbench_onboarding_action(
    payload: dict,
    *,
    search: str = "?onboarding=create_or_join_enterprise",
    enterprise_name: str = "",
    invite_code: str = "",
    trigger_create: bool = False,
    trigger_join: bool = False,
    join_should_fail: bool = False,
) -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(WORKBENCH_MODULE_PATH))}, 'utf8');

function createElement(id) {{
  return {{
    id: id || '',
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    listeners: {{}},
    style: {{}},
    addEventListener(type, handler) {{
      this.listeners[type] = handler;
    }},
    dispatch(eventName) {{
      if (this.listeners[eventName]) {{
        return this.listeners[eventName].call(this, {{ preventDefault() {{}} }});
      }}
      return undefined;
    }},
  }};
}}

const fetchCalls = [];
const onboardingError = createElement('workbench-onboarding-error');
const createInput = createElement('workbench-enterprise-name');
createInput.value = {json.dumps(enterprise_name)};
const joinInput = createElement('workbench-invite-code');
joinInput.value = {json.dumps(invite_code)};
const createForm = createElement('workbench-create-enterprise-form');
const joinForm = createElement('workbench-join-enterprise-form');

const queryMap = {{
  '[data-workbench-onboarding-error]': onboardingError,
  '[data-workbench-enterprise-name]': createInput,
  '[data-workbench-invite-code]': joinInput,
  '[data-workbench-create-enterprise-form]': createForm,
  '[data-workbench-join-enterprise-form]': joinForm,
}};

global.window = {{
  location: {{
    search: {json.dumps(search)},
    href: 'http://localhost/app/workbench?onboarding=create_or_join_enterprise',
  }},
  aiteam: {{
    util: {{
      escapeHtml(value) {{
        return String(value == null ? '' : value);
      }},
    }},
    pages: {{}},
    states: {{
      renderEmpty(container, message, actionHtml) {{
        container.innerHTML = '<div data-state-empty="1"><p>' + message + '</p>' + (actionHtml || '') + '</div>';
      }},
    }},
    api: {{
      post(path, body) {{
        fetchCalls.push({{ path, body }});
        if (path === '/api/auth/onboarding/create-enterprise') {{
          return Promise.resolve({{
            ok: true,
            status: 201,
            data: {{
              enterprise_id: 'ent_new',
              name: body.name,
              slug: 'acme-ai-lab',
              role: 'owner',
            }},
            error: null,
          }});
        }}
        if (path === '/api/auth/onboarding/join-enterprise') {{
          if ({json.dumps(join_should_fail)}) {{
            return Promise.resolve({{
              ok: false,
              status: 404,
              data: null,
              error: 'Invite code is invalid or expired',
            }});
          }}
          return Promise.resolve({{
            ok: true,
            status: 200,
            data: {{
              enterprise_id: 'ent_existing_acme',
              name: 'Acme AI Lab',
              slug: 'acme-ai-lab',
              role: 'member',
            }},
            error: null,
          }});
        }}
        return Promise.resolve({{ ok: false, status: 500, data: null, error: 'unexpected request' }});
      }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'app-workbench.js' }});

const container = {{
  _html: '',
  get innerHTML() {{
    return this._html;
  }},
  set innerHTML(value) {{
    this._html = String(value || '');
  }},
  querySelector(selector) {{
    return queryMap[selector] || null;
  }},
  querySelectorAll(selector) {{
    if (selector === '[data-select-employee]') return [];
    return [];
  }},
}};

aiteam.pages.appWorkbench.render(container, {json.dumps(payload, ensure_ascii=False)});

Promise.resolve()
  .then(async () => {{
    if ({json.dumps(trigger_create)}) {{
      await createForm.dispatch('submit');
    }}
    if ({json.dumps(trigger_join)}) {{
      await joinForm.dispatch('submit');
    }}
    console.log(JSON.stringify({{
      html: container.innerHTML,
      href: window.location.href,
      onboardingError: onboardingError.textContent,
      fetchCalls,
    }}));
  }})
  .catch((error) => {{
    console.error(error && error.stack ? error.stack : String(error));
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


def _run_workbench_init(result: dict) -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(ROOT / "static" / "aiteam" / "api-client.js"))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(ROOT / "static" / "aiteam" / "state-helpers.js"))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(WORKBENCH_MODULE_PATH))}, 'utf8');

global.window = {{
  location: {{ search: '' }},
  aiteam: {{
    util: {{
      escapeHtml(value) {{
        return String(value == null ? '' : value);
      }},
    }},
    pages: {{}},
  }},
}};
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
  return {{
    ok: {json.dumps(result.get("ok", False))},
    status: {json.dumps(result.get("status", 0))},
    statusText: {json.dumps(result.get("status_text", "Forbidden"))},
    async text() {{
      return {json.dumps(json.dumps(result.get("body")))};
    }},
  }};
}};
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(moduleSource, {{ filename: 'app-workbench.js' }});

(async () => {{
  const container = {{ innerHTML: '' }};
  aiteam.pages.appWorkbench.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{ html: container.innerHTML }}));
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


def _run_workbench_search_filter_lifecycle(payload: dict, search_value: str) -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(WORKBENCH_MODULE_PATH))}, 'utf8');

function makeSearchInput() {{
  return {{
    value: '',
    listeners: {{}},
    addEventListener(type, handler) {{ this.listeners[type] = handler; }},
    dispatchInput() {{
      if (this.listeners.input) this.listeners.input.call(this, {{ currentTarget: this, preventDefault() {{}} }});
    }},
  }};
}}

function makeEmployeeButton(employeeId) {{
  return {{
    employeeId,
    listeners: {{}},
    addEventListener(type, handler) {{ this.listeners[type] = handler; }},
    getAttribute(name) {{ return name === 'data-select-employee' ? this.employeeId : null; }},
  }};
}}

global.window = {{
  location: {{ search: '' }},
  aiteam: {{
    util: {{
      escapeHtml(value) {{
        return String(value == null ? '' : value);
      }},
    }},
    pages: {{}},
    states: {{
      renderEmpty(container, message, actionHtml) {{
        container.innerHTML = '<div data-state-empty="1"><p>' + message + '</p>' + (actionHtml || '') + '</div>';
      }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'app-workbench.js' }});

const searchInput = makeSearchInput();
let employeeButtons = [];
const container = {{
  _html: '',
  get innerHTML() {{
    return this._html;
  }},
  set innerHTML(value) {{
    this._html = String(value || '');
    const matches = [...this._html.matchAll(/data-select-employee="([^"]+)"/g)];
    employeeButtons = matches.map((match) => makeEmployeeButton(match[1]));
  }},
  querySelector(selector) {{
    if (selector === '[data-workbench-search]') return searchInput;
    return null;
  }},
  querySelectorAll(selector) {{
    if (selector === '[data-select-employee]') return employeeButtons;
    return [];
  }},
}};

aiteam.pages.appWorkbench.render(container, {json.dumps(payload, ensure_ascii=False)});
const initialHtml = container.innerHTML;
searchInput.value = {json.dumps(search_value)};
searchInput.dispatchInput();
const filteredHtml = container.innerHTML;
console.log(JSON.stringify({{ initialHtml, filteredHtml }}));
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def test_workbench_empty_state_uses_prd_split_shell_instead_of_generic_empty_state() -> None:
    result = _run_workbench(
        {
            "enterprise": {"enterprise_id": "ent_demo", "name": "示例企业"},
            "employees": [],
            "groups": [],
            "office_digest": {"online_employee_count": 0, "running_task_count": 0},
        }
    )
    assert "data-workbench-shell" in result["html"]
    assert "data-workbench-rail" in result["html"]
    assert 'href="/app/group"' in result["html"]
    assert 'href="/app/knowledge"' in result["html"]
    assert "data-workbench-empty" in result["html"]
    assert "前往人才市场" in result["html"]
    assert "从左侧选择员工开始对话" in result["html"]
    assert "data-state-empty" not in result["html"]


def test_workbench_populated_state_renders_search_employee_list_and_main_stage() -> None:
    result = _run_workbench(
        {
            "enterprise": {"enterprise_id": "ent_demo", "name": "示例企业"},
            "employees": [
                {
                    "employee_id": "emp_rex",
                    "display_name": "Rex",
                    "role_name": "代码工程师",
                    "status": "active",
                    "presence": "busy",
                    "conversation_id": "conv_rex",
                    "last_message_preview": "已整理本周回归结论",
                    "unread_count": 2,
                },
                {
                    "employee_id": "emp_nova",
                    "display_name": "Nova",
                    "role_name": "数据科学家",
                    "status": "active",
                    "presence": "online",
                    "conversation_id": "conv_nova",
                    "last_message_preview": "等待新的分析任务",
                    "unread_count": 0,
                    "avatar_url": "https://example.test/nova.png",
                    "last_active_at": "2026-06-10T10:00:00Z",
                    "is_starred": True,
                },
            ],
            "groups": [
                {
                    "conversation_id": "group_ops",
                    "title": "运营协作组",
                    "member_count": 3,
                    "running_count": 1,
                    "last_message_preview": "等待补充结论",
                }
            ],
            "office_digest": {"online_employee_count": 2, "running_task_count": 1},
        }
    )
    assert "data-workbench-shell" in result["html"]
    assert "data-workbench-rail" in result["html"]
    assert "私聊" in result["html"]
    assert "群聊" in result["html"]
    assert "知识库" in result["html"]
    assert "设置" in result["html"]
    assert "data-workbench-search" in result["html"]
    assert "data-workbench-list" in result["html"]
    assert "data-workbench-main" in result["html"]
    assert "Rex" in result["html"]
    assert "Nova" in result["html"]
    assert "运营协作组" in result["html"]
    assert "继续对话" in result["html"]
    assert "快捷操作" in result["html"]
    assert "查看详情" in result["html"]
    assert "设置为星标" in result["html"]
    assert "解雇" in result["html"]
    assert "data-workbench-avatar" in result["html"]
    assert "https://example.test/nova.png" in result["html"]
    assert "title=\"私聊\"" in result["html"]
    assert "title=\"群聊\"" in result["html"]
    assert "title=\"组织架构\"" in result["html"]
    assert "title=\"人才市场\"" in result["html"]
    assert "data-workbench-context-menu" in result["html"]
    assert "data-workbench-starred" in result["html"]
    assert 'href="/app/group"' in result["html"]
    assert 'href="/app/org"' in result["html"]


def test_workbench_renders_recent_conversations_and_task_digest_panels() -> None:
    result = _run_workbench(
        {
            "enterprise": {"enterprise_id": "ent_demo", "name": "示例企业"},
            "employees": [
                {
                    "employee_id": "emp_rex",
                    "display_name": "Rex",
                    "role_name": "代码工程师",
                    "status": "active",
                    "presence": "busy",
                    "conversation_id": "conv_rex",
                    "last_message_preview": "已整理本周回归结论",
                    "unread_count": 2,
                }
            ],
            "groups": [
                {
                    "conversation_id": "group_ops",
                    "title": "运营协作组",
                    "member_count": 3,
                    "running_count": 1,
                    "last_message_preview": "等待补充结论",
                }
            ],
            "recent_conversations": [
                {
                    "id": "conv_rex",
                    "title": "Rex 私聊",
                    "conv_type": "private",
                    "display_state": "busy",
                    "last_preview": "已整理本周回归结论",
                    "navigation_target": "/app/chat/conv_rex",
                    "latest_run_status": "running",
                    "member_count": 1,
                    "task_status_digest": {"total": 1, "running": 1},
                },
                {
                    "id": "group_ops",
                    "title": "运营协作组",
                    "conv_type": "group",
                    "display_state": "resolved",
                    "last_preview": "等待补充结论",
                    "navigation_target": "/app/group/group_ops",
                    "latest_run_status": "succeeded",
                    "member_count": 3,
                    "task_status_digest": {"total": 4, "succeeded": 3, "running": 1},
                },
            ],
            "task_status_digest": {
                "total": 6,
                "running": 2,
                "queued": 1,
                "succeeded": 3,
                "failed": 0,
            },
            "office_digest": {"online_employee_count": 1, "running_task_count": 2},
        }
    )
    assert "最近会话" in result["html"]
    assert "Rex 私聊" in result["html"]
    assert "运营协作组" in result["html"]
    assert 'href="/app/chat/conv_rex"' in result["html"]
    assert 'href="/app/group/group_ops"' in result["html"]
    assert "任务摘要" in result["html"]
    assert "运行中 2" in result["html"]
    assert "排队中 1" in result["html"]
    assert "已完成 3" in result["html"]


def test_workbench_renders_enterprise_onboarding_hint_when_login_redirect_marks_it() -> None:
    result = _run_workbench(
        {
            "enterprise": {"enterprise_id": "ent_demo", "name": "示例企业"},
            "employees": [
                {
                    "employee_id": "emp_rex",
                    "display_name": "Rex",
                    "role_name": "代码工程师",
                    "status": "active",
                    "presence": "busy",
                    "conversation_id": "conv_rex",
                    "last_message_preview": "已整理本周回归结论",
                    "unread_count": 2,
                }
            ],
            "groups": [],
            "office_digest": {"online_employee_count": 1, "running_task_count": 0},
            "onboarding_hint": {
                "action": "create_or_join_enterprise",
                "title": "完成企业入驻后再开始使用",
                "message": "你已登录成功，下一步需要创建企业或加入已有企业空间。",
                "primary_label": "创建企业",
                "primary_target": "/admin/settings?tab=enterprise",
                "secondary_label": "加入企业",
                "secondary_target": "/admin/settings?tab=invites",
            },
        }
    )
    assert "完成企业入驻后再开始使用" in result["html"]
    assert "创建企业或加入已有企业空间" in result["html"]
    assert 'data-workbench-create-enterprise-form="1"' in result["html"]
    assert 'data-workbench-join-enterprise-form="1"' in result["html"]
    assert 'data-workbench-enterprise-name="1"' in result["html"]
    assert 'data-workbench-invite-code="1"' in result["html"]


def test_workbench_reads_enterprise_onboarding_hint_from_location_query() -> None:
    result = _run_workbench(
        {
            "enterprise": {"enterprise_id": "ent_demo", "name": "示例企业"},
            "employees": [
                {
                    "employee_id": "emp_rex",
                    "display_name": "Rex",
                    "role_name": "代码工程师",
                    "status": "active",
                    "presence": "busy",
                    "conversation_id": "conv_rex",
                    "last_message_preview": "已整理本周回归结论",
                    "unread_count": 2,
                }
            ],
            "groups": [],
            "office_digest": {"online_employee_count": 1, "running_task_count": 0},
        },
        search="?onboarding=create_or_join_enterprise",
    )
    assert "完成企业入驻后再开始使用" in result["html"]
    assert "创建企业或加入已有企业空间" in result["html"]
    assert 'data-workbench-create-enterprise-form="1"' in result["html"]
    assert 'data-workbench-join-enterprise-form="1"' in result["html"]


def test_workbench_onboarding_create_enterprise_submits_and_redirects() -> None:
    result = _run_workbench_onboarding_action(
        {
            "enterprise": {"enterprise_id": "ent_demo", "name": "示例企业"},
            "employees": [],
            "groups": [],
            "office_digest": {"online_employee_count": 0, "running_task_count": 0},
        },
        enterprise_name="Acme AI Lab",
        trigger_create=True,
    )

    assert any(call["path"] == "/api/auth/onboarding/create-enterprise" for call in result["fetchCalls"])
    assert result["href"] == "/app/workbench"


def test_workbench_onboarding_join_enterprise_shows_inline_error_on_invalid_code() -> None:
    result = _run_workbench_onboarding_action(
        {
            "enterprise": {"enterprise_id": "ent_demo", "name": "示例企业"},
            "employees": [],
            "groups": [],
            "office_digest": {"online_employee_count": 0, "running_task_count": 0},
        },
        invite_code="INV-UNKNOWN",
        trigger_join=True,
        join_should_fail=True,
    )

    assert any(call["path"] == "/api/auth/onboarding/join-enterprise" for call in result["fetchCalls"])
    assert result["onboardingError"] == "Invite code is invalid or expired"
    assert result["href"] == "http://localhost/app/workbench?onboarding=create_or_join_enterprise"


def test_workbench_starred_employee_is_sorted_to_top_and_context_menu_matches_prd_actions() -> None:
    result = _run_workbench(
        {
            "enterprise": {"enterprise_id": "ent_demo", "name": "示例企业"},
            "employees": [
                {
                    "employee_id": "emp_rex",
                    "display_name": "Rex",
                    "role_name": "代码工程师",
                    "status": "active",
                    "presence": "busy",
                    "conversation_id": "conv_rex",
                    "last_message_preview": "已整理本周回归结论",
                    "unread_count": 2,
                    "last_active_at": "2026-06-10T09:00:00Z",
                    "is_starred": False,
                },
                {
                    "employee_id": "emp_nova",
                    "display_name": "Nova",
                    "role_name": "数据科学家",
                    "status": "active",
                    "presence": "online",
                    "conversation_id": "conv_nova",
                    "last_message_preview": "等待新的分析任务",
                    "unread_count": 0,
                    "last_active_at": "2026-06-10T08:00:00Z",
                    "is_starred": True,
                },
            ],
            "groups": [],
            "office_digest": {"online_employee_count": 2, "running_task_count": 1},
        }
    )
    assert result["html"].index("Nova") < result["html"].index("Rex")
    assert "查看详情" in result["html"]
    assert "设置为星标" in result["html"]
    assert "解雇" in result["html"]


def test_workbench_search_with_no_match_clears_selected_employee_panel() -> None:
    result = _run_workbench_search_filter_lifecycle(
        {
            "enterprise": {"enterprise_id": "ent_demo", "name": "示例企业"},
            "employees": [
                {
                    "employee_id": "emp_rex",
                    "display_name": "Rex",
                    "role_name": "代码工程师",
                    "status": "active",
                    "presence": "busy",
                    "conversation_id": "conv_rex",
                    "last_message_preview": "已整理本周回归结论",
                    "unread_count": 2,
                },
                {
                    "employee_id": "emp_nova",
                    "display_name": "Nova",
                    "role_name": "数据科学家",
                    "status": "active",
                    "presence": "online",
                    "conversation_id": "conv_nova",
                    "last_message_preview": "等待新的分析任务",
                    "unread_count": 0,
                },
            ],
            "groups": [],
            "office_digest": {"online_employee_count": 2, "running_task_count": 1},
        },
        "zzz-no-match",
    )
    assert "当前选中员工" in result["initialHtml"]
    assert "当前筛选下没有匹配员工" in result["filteredHtml"]
    assert "当前选中员工" not in result["filteredHtml"]


def test_workbench_init_keeps_prd_shell_when_permission_denied() -> None:
    result = _run_workbench_init(
        {
            "ok": False,
            "status": 403,
            "status_text": "Forbidden",
            "body": {
                "error": {
                    "code": "PERMISSION_DENIED",
                    "message": "当前账号没有查看工作台的权限",
                    "retryable": False,
                }
            },
        }
    )
    assert "data-workbench-shell" in result["html"]
    assert "data-workbench-rail" in result["html"]
    assert "当前账号没有查看工作台的权限" in result["html"]
    assert "aiteam-state-denied" in result["html"]
    assert "私聊" in result["html"]


def test_workbench_init_keeps_prd_shell_when_load_fails() -> None:
    result = _run_workbench_init(
        {
            "ok": False,
            "status": 500,
            "status_text": "Internal Server Error",
            "body": {
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "工作台聚合暂时不可用",
                    "retryable": True,
                }
            },
        }
    )
    assert "data-workbench-shell" in result["html"]
    assert "data-workbench-rail" in result["html"]
    assert "工作台聚合暂时不可用" in result["html"]
    assert "aiteam-state-error" in result["html"]
    assert "查看群聊" in result["html"]
