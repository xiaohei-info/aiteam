from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
GROUP_PAGE_PATH = ROOT / "static" / "aiteam" / "pages" / "app-group.js"


def _render_group_page(conversation: dict) -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const pageSource = fs.readFileSync({json.dumps(str(GROUP_PAGE_PATH))}, 'utf8');
const noopNode = () => ({{
  innerHTML: '',
  textContent: '',
  value: '',
  addEventListener() {{}},
  scrollIntoView() {{}},
  focus() {{}},
}});
const refs = {{
  transcript: noopNode(),
  timeline: noopNode(),
  taskTree: noopNode(),
  members: noopNode(),
  mentionStrip: noopNode(),
  status: noopNode(),
  input: Object.assign(noopNode(), {{ value: '' }}),
  route: Object.assign(noopNode(), {{ value: 'auto' }}),
  sender: Object.assign(noopNode(), {{ value: 'user_1' }}),
  settingsCard: noopNode(),
  routeMode: noopNode(),
  routeDesc: noopNode(),
  routeTargets: noopNode(),
  runtimeHandle: noopNode(),
  mentionState: noopNode(),
  collabState: noopNode(),
  recoveryLabel: noopNode(),
  recovery: noopNode(),
  form: noopNode(),
  reconnect: noopNode(),
  openSettings: noopNode(),
}};
const container = {{
  innerHTML: '',
  querySelector(selector) {{
    const map = {{
      '[data-group-transcript]': refs.transcript,
      '[data-group-timeline]': refs.timeline,
      '[data-group-task-tree]': refs.taskTree,
      '[data-group-members]': refs.members,
      '[data-group-mention-strip]': refs.mentionStrip,
      '[data-group-status]': refs.status,
      '[data-group-input]': refs.input,
      '[data-group-route]': refs.route,
      '[data-group-sender]': refs.sender,
      '[data-group-settings-card]': refs.settingsCard,
      '[data-group-route-mode]': refs.routeMode,
      '[data-group-route-desc]': refs.routeDesc,
      '[data-group-route-targets]': refs.routeTargets,
      '[data-group-runtime-handle]': refs.runtimeHandle,
      '[data-group-mention-state]': refs.mentionState,
      '[data-group-collab-state]': refs.collabState,
      '[data-group-recovery-label]': refs.recoveryLabel,
      '[data-group-recovery]': refs.recovery,
      '[data-group-form]': refs.form,
      '[data-group-reconnect]': refs.reconnect,
      '[data-group-open-settings]': refs.openSettings,
    }};
    return map[selector] || null;
  }},
  querySelectorAll(selector) {{
    if (selector === '[data-mention]') return [];
    return [];
  }},
}};
global.window = {{
  location: {{ pathname: '/app/group/group_ops', href: 'http://example.test/app/group/group_ops' }},
  localStorage: {{ getItem() {{ return ''; }}, setItem() {{}}, removeItem() {{}} }},
  aiteam: {{
    util: {{ escapeHtml(value) {{ return String(value == null ? '' : value); }} }},
    states: {{ renderLoading() {{}}, renderError() {{}}, handleApiResult() {{}} }},
    timeline: {{ connect() {{}}, disconnect() {{}}, setCurrentCursor() {{}}, getCurrentCursor() {{ return 0; }} }},
    api: {{ getRunEvents() {{ return Promise.resolve({{ ok: true, data: {{ items: [], next_cursor: 0, latest_event_cursor: 0, run_status: 'idle' }} }}); }} }},
    pages: {{}},
  }},
}};
global.document = {{ baseURI: 'http://example.test/app/group/group_ops' }};
global.aiteam = global.window.aiteam;
vm.runInThisContext(pageSource, {{ filename: 'app-group.js' }});
aiteam.pages.appGroup.render(container, {json.dumps(conversation, ensure_ascii=False)});
setTimeout(() => {{
  console.log(JSON.stringify({{ html: container.innerHTML }}));
}}, 0);
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def _run_group_launcher_flow() -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const pageSource = fs.readFileSync({json.dumps(str(GROUP_PAGE_PATH))}, 'utf8');
const apiCalls = [];
function makeNode(initialValue = '') {{
  return {{
    value: initialValue,
    checked: false,
    listeners: {{}},
    textContent: '',
    innerHTML: '',
    addEventListener(type, handler) {{ this.listeners[type] = handler; }},
    dispatch(type) {{
      if (this.listeners[type]) this.listeners[type].call(this, {{ currentTarget: this, preventDefault() {{}} }});
    }},
  }};
}}
const titleInput = makeNode('新品启动群');
const memberInputs = {{
  emp_test: Object.assign(makeNode(''), {{ checked: true, getAttribute(name) {{ return name === 'data-group-create-member' ? 'emp_test' : null; }} }}),
  emp_member: Object.assign(makeNode(''), {{ checked: true, getAttribute(name) {{ return name === 'data-group-create-member' ? 'emp_member' : null; }} }}),
  emp_planner: Object.assign(makeNode(''), {{ checked: false, getAttribute(name) {{ return name === 'data-group-create-member' ? 'emp_planner' : null; }} }}),
}};
const employees = [
  {{ employee_id: 'emp_test', display_name: 'Alice', role_name: '产品经理', status: 'active' }},
  {{ employee_id: 'emp_member', display_name: 'Bob', role_name: '工程师', status: 'active' }},
  {{ employee_id: 'emp_planner', display_name: 'Cara', role_name: '研究员', status: 'active' }},
];
const conversation = {{
  conversation_id: 'group_new',
  title: '新品启动群',
  display_state: 'active',
  default_route_hint: 'auto',
  member_count: 2,
  members: [
    {{ employee_id: 'emp_test', display_name: 'Alice', role_name: '产品经理' }},
    {{ employee_id: 'emp_member', display_name: 'Bob', role_name: '工程师' }},
  ],
  latest_run: null,
  timeline: {{ run_id: null, latest_event_cursor: 0 }},
  latest_route_decision: null,
  task_tree: {{ items: [] }},
}};
const container = {{
  innerHTML: '',
  querySelector(selector) {{
    if (selector === '[data-group-create-title]') return titleInput;
    if (selector === '[data-group-create-launch]') return makeNode();
    if (selector === '[data-group-create-status]') return makeNode();
    return null;
  }},
  querySelectorAll(selector) {{
    if (selector === '[data-group-create-member]') return [memberInputs.emp_test, memberInputs.emp_member, memberInputs.emp_planner];
    return [];
  }},
}};
global.window = {{
  location: {{ pathname: '/app/group', href: 'http://example.test/app/group' }},
  localStorage: {{ getItem() {{ return ''; }}, setItem() {{}}, removeItem() {{}} }},
  aiteam: {{
    util: {{ escapeHtml(value) {{ return String(value == null ? '' : value); }} }},
    states: {{ renderLoading() {{}}, renderError() {{}}, handleApiResult() {{}} }},
    timeline: {{ connect() {{}}, disconnect() {{}}, setCurrentCursor() {{}}, getCurrentCursor() {{ return 0; }} }},
    api: {{
      getEmployees() {{
        apiCalls.push({{ method: 'GET', path: '/api/team/employees' }});
        return Promise.resolve({{ ok: true, data: {{ items: employees }} }});
      }},
      createGroupConversation(body) {{
        apiCalls.push({{ method: 'POST', path: '/api/team/group-conversations', body }});
        return Promise.resolve({{ ok: true, data: {{ conversation_id: 'group_new', navigation: {{ conversation: '/app/group/group_new' }} }} }});
      }},
      getGroupConversation(conversationId) {{
        apiCalls.push({{ method: 'GET', path: '/api/team/group-conversations/' + conversationId }});
        return Promise.resolve({{ ok: true, data: conversation }});
      }},
      getRunEvents() {{
        return Promise.resolve({{ ok: true, data: {{ items: [], next_cursor: 0, latest_event_cursor: 0, run_status: 'idle' }} }});
      }},
    }},
    pages: {{}},
  }},
}};
global.document = {{ baseURI: 'http://example.test/app/group' }};
global.aiteam = global.window.aiteam;
vm.runInThisContext(pageSource, {{ filename: 'app-group.js' }});
aiteam.pages.appGroup.init(container, {{ pathname: '/app/group' }});
Promise.resolve().then(() => new Promise((resolve) => setTimeout(resolve, 0))).then(async () => {{
  const launcherHtml = container.innerHTML;
  titleInput.value = '预算评审群';
  titleInput.dispatch('input');
  memberInputs.emp_test.checked = false;
  memberInputs.emp_test.dispatch('change');
  memberInputs.emp_planner.checked = true;
  memberInputs.emp_planner.dispatch('change');
  const updatedLauncherHtml = container.innerHTML;
  await container.lastCreateGroupHandler({{ title: '预算评审群', member_employee_ids: ['emp_member', 'emp_planner'] }});
  await new Promise((resolve) => setTimeout(resolve, 0));
  console.log(JSON.stringify({{ launcherHtml, updatedLauncherHtml, html: container.innerHTML, apiCalls }}));
}}).catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def _run_group_launcher_member_limit_flow() -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const pageSource = fs.readFileSync({json.dumps(str(GROUP_PAGE_PATH))}, 'utf8');
function makeNode(initialValue = '') {{
  return {{
    value: initialValue,
    checked: false,
    disabled: false,
    listeners: {{}},
    textContent: '',
    innerHTML: '',
    addEventListener(type, handler) {{ this.listeners[type] = handler; }},
    dispatch(type) {{
      if (this.listeners[type]) this.listeners[type].call(this, {{ currentTarget: this, preventDefault() {{}} }});
    }},
  }};
}}
const titleInput = makeNode('群聊上限测试');
const memberInputs = {{}};
const employees = [];
for (let i = 1; i <= 11; i += 1) {{
  const employeeId = 'emp_' + i;
  memberInputs[employeeId] = Object.assign(makeNode(''), {{
    checked: i <= 2,
    getAttribute(name) {{ return name === 'data-group-create-member' ? employeeId : null; }},
  }});
  employees.push({{
    employee_id: employeeId,
    display_name: '成员' + i,
    role_name: '分析师',
    status: 'active',
  }});
}}
const container = {{
  innerHTML: '',
  querySelector(selector) {{
    if (selector === '[data-group-create-title]') return titleInput;
    if (selector === '[data-group-create-launch]') return makeNode();
    if (selector === '[data-group-create-status]') return makeNode();
    return null;
  }},
  querySelectorAll(selector) {{
    if (selector === '[data-group-create-member]') return Object.values(memberInputs);
    return [];
  }},
}};
global.window = {{
  location: {{ pathname: '/app/group', href: 'http://example.test/app/group' }},
  localStorage: {{ getItem() {{ return ''; }}, setItem() {{}}, removeItem() {{}} }},
  aiteam: {{
    util: {{ escapeHtml(value) {{ return String(value == null ? '' : value); }} }},
    states: {{ renderLoading() {{}}, renderError() {{}}, handleApiResult() {{}} }},
    timeline: {{ connect() {{}}, disconnect() {{}}, setCurrentCursor() {{}}, getCurrentCursor() {{ return 0; }} }},
    api: {{
      getEmployees() {{
        return Promise.resolve({{ ok: true, data: {{ items: employees }} }});
      }},
      createGroupConversation() {{
        return Promise.resolve({{ ok: true, data: {{ conversation_id: 'group_new' }} }});
      }},
      getGroupConversation() {{
        return Promise.resolve({{ ok: true, data: {{ conversation_id: 'group_new', title: '群聊上限测试', members: [] }} }});
      }},
      getRunEvents() {{
        return Promise.resolve({{ ok: true, data: {{ items: [], next_cursor: 0, latest_event_cursor: 0, run_status: 'idle' }} }});
      }},
    }},
    pages: {{}},
  }},
}};
global.document = {{ baseURI: 'http://example.test/app/group' }};
global.aiteam = global.window.aiteam;
vm.runInThisContext(pageSource, {{ filename: 'app-group.js' }});
aiteam.pages.appGroup.init(container, {{ pathname: '/app/group' }});
Promise.resolve().then(() => new Promise((resolve) => setTimeout(resolve, 0))).then(async () => {{
  const initialHtml = container.innerHTML;
  for (let i = 3; i <= 10; i += 1) {{
    const key = 'emp_' + i;
    memberInputs[key].checked = true;
    memberInputs[key].dispatch('change');
  }}
  const tenSelectedHtml = container.innerHTML;
  memberInputs.emp_11.checked = true;
  memberInputs.emp_11.dispatch('change');
  const cappedHtml = container.innerHTML;
  console.log(JSON.stringify({{
    initialHtml,
    tenSelectedHtml,
    cappedHtml,
  }}));
}}).catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def _run_group_management_actions() -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const pageSource = fs.readFileSync({json.dumps(str(GROUP_PAGE_PATH))}, 'utf8');
const apiCalls = [];
const noopNode = () => ({{
  innerHTML: '',
  textContent: '',
  value: '',
  addEventListener() {{}},
  scrollIntoView() {{}},
  focus() {{}},
}});
const refs = {{
  transcript: noopNode(),
  timeline: noopNode(),
  taskTree: noopNode(),
  members: noopNode(),
  mentionStrip: noopNode(),
  status: noopNode(),
  input: Object.assign(noopNode(), {{ value: '' }}),
  route: Object.assign(noopNode(), {{ value: 'auto' }}),
  sender: Object.assign(noopNode(), {{ value: 'user_1' }}),
  settingsCard: noopNode(),
  routeMode: noopNode(),
  routeDesc: noopNode(),
  routeTargets: noopNode(),
  runtimeHandle: noopNode(),
  mentionState: noopNode(),
  collabState: noopNode(),
  recoveryLabel: noopNode(),
  recovery: noopNode(),
  form: noopNode(),
  reconnect: noopNode(),
  openSettings: noopNode(),
}};
const container = {{
  innerHTML: '',
  querySelector(selector) {{
    const map = {{
      '[data-group-transcript]': refs.transcript,
      '[data-group-timeline]': refs.timeline,
      '[data-group-task-tree]': refs.taskTree,
      '[data-group-members]': refs.members,
      '[data-group-mention-strip]': refs.mentionStrip,
      '[data-group-status]': refs.status,
      '[data-group-input]': refs.input,
      '[data-group-route]': refs.route,
      '[data-group-sender]': refs.sender,
      '[data-group-settings-card]': refs.settingsCard,
      '[data-group-route-mode]': refs.routeMode,
      '[data-group-route-desc]': refs.routeDesc,
      '[data-group-route-targets]': refs.routeTargets,
      '[data-group-runtime-handle]': refs.runtimeHandle,
      '[data-group-mention-state]': refs.mentionState,
      '[data-group-collab-state]': refs.collabState,
      '[data-group-recovery-label]': refs.recoveryLabel,
      '[data-group-recovery]': refs.recovery,
      '[data-group-form]': refs.form,
      '[data-group-reconnect]': refs.reconnect,
      '[data-group-open-settings]': refs.openSettings,
    }};
    return map[selector] || null;
  }},
  querySelectorAll(selector) {{
    if (selector === '[data-mention]') return [];
    return [];
  }},
}};
const snapshots = [
  {{
    conversation_id: 'group_ops',
    title: '运营协作组',
    display_state: 'active',
    default_route_hint: 'auto',
    member_count: 3,
    members: [
      {{ member_id: 'mem_test', employee_id: 'emp_test', display_name: 'Alice', role_name: '产品经理' }},
      {{ member_id: 'mem_member', employee_id: 'emp_member', display_name: 'Bob', role_name: '工程师' }},
      {{ member_id: 'mem_planner', employee_id: 'emp_planner', display_name: 'Cara', role_name: '研究员' }},
    ],
    latest_run: null,
    timeline: {{ run_id: null, latest_event_cursor: 0 }},
    latest_route_decision: null,
    task_tree: {{ items: [] }},
  }},
  {{
    conversation_id: 'group_ops',
    title: '运营协作组',
    display_state: 'active',
    default_route_hint: 'auto',
    member_count: 2,
    members: [
      {{ member_id: 'mem_test', employee_id: 'emp_test', display_name: 'Alice', role_name: '产品经理' }},
      {{ member_id: 'mem_planner', employee_id: 'emp_planner', display_name: 'Cara', role_name: '研究员' }},
    ],
    latest_run: null,
    timeline: {{ run_id: null, latest_event_cursor: 0 }},
    latest_route_decision: null,
    task_tree: {{ items: [] }},
  }},
];
global.window = {{
  location: {{ pathname: '/app/group/group_ops', href: 'http://example.test/app/group/group_ops' }},
  localStorage: {{ getItem() {{ return ''; }}, setItem() {{}}, removeItem() {{}} }},
  aiteam: {{
    util: {{ escapeHtml(value) {{ return String(value == null ? '' : value); }} }},
    states: {{ renderLoading() {{}}, renderError() {{}}, handleApiResult() {{}} }},
    timeline: {{ connect() {{}}, disconnect() {{}}, setCurrentCursor() {{}}, getCurrentCursor() {{ return 0; }} }},
    api: {{
      addGroupConversationMember(conversationId, body) {{
        apiCalls.push({{ method: 'POST', path: '/api/team/group-conversations/' + conversationId + '/members', body }});
        return Promise.resolve({{ ok: true, data: {{ member_id: 'mem_planner', employee_id: 'emp_planner', status: 'active' }} }});
      }},
      removeGroupConversationMember(conversationId, memberId) {{
        apiCalls.push({{ method: 'DELETE', path: '/api/team/group-conversations/' + conversationId + '/members/' + memberId }});
        return Promise.resolve({{ ok: true, data: {{ member_id: memberId, status: 'removed' }} }});
      }},
      archiveGroupConversation(conversationId) {{
        apiCalls.push({{ method: 'DELETE', path: '/api/team/group-conversations/' + conversationId }});
        return Promise.resolve({{ ok: true, data: {{ conversation_id: conversationId, status: 'archived' }} }});
      }},
      getGroupConversation() {{
        apiCalls.push({{ method: 'GET', path: '/api/team/group-conversations/group_ops' }});
        return Promise.resolve({{ ok: true, data: snapshots.shift() }});
      }},
      getRunEvents() {{
        return Promise.resolve({{ ok: true, data: {{ items: [], next_cursor: 0, latest_event_cursor: 0, run_status: 'idle' }} }});
      }},
    }},
    pages: {{}},
  }},
}};
global.document = {{ baseURI: 'http://example.test/app/group/group_ops' }};
global.aiteam = global.window.aiteam;
vm.runInThisContext(pageSource, {{ filename: 'app-group.js' }});
aiteam.pages.appGroup.render(container, {{
  conversation_id: 'group_ops',
  title: '运营协作组',
  display_state: 'active',
  default_route_hint: 'auto',
  member_count: 2,
  members: [
    {{ member_id: 'mem_test', employee_id: 'emp_test', display_name: 'Alice', role_name: '产品经理' }},
    {{ member_id: 'mem_member', employee_id: 'emp_member', display_name: 'Bob', role_name: '工程师' }},
  ],
  latest_run: null,
  timeline: {{ run_id: null, latest_event_cursor: 0 }},
  latest_route_decision: null,
  task_tree: {{ items: [] }},
}});
Promise.resolve().then(async () => {{
  await container.lastAddMemberHandler({{ employee_id: 'emp_planner' }});
  await container.lastRemoveMemberHandler('mem_member');
  await container.lastArchiveGroupHandler();
  await new Promise((resolve) => setTimeout(resolve, 0));
  console.log(JSON.stringify({{ html: container.innerHTML, apiCalls, status: refs.status.textContent }}));
}}).catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def test_group_page_renders_new_group_entry_avatar_grid_and_member_actions() -> None:
    payload = _render_group_page(
        {
            "conversation_id": "group_ops",
            "title": "运营协作组",
            "display_state": "busy",
            "default_route_hint": "auto",
            "member_count": 4,
            "members": [
                {"employee_id": "emp_1", "display_name": "Alice", "role_name": "产品经理"},
                {"employee_id": "emp_2", "display_name": "Bob", "role_name": "工程师"},
                {"employee_id": "emp_3", "display_name": "Cara", "role_name": "研究员"},
                {"employee_id": "emp_4", "display_name": "Drew", "role_name": "分析师"},
            ],
            "latest_run": {
                "run_id": "run_group_1",
                "status": "running",
                "latest_event_cursor": 5,
                "runtime_handle": {"kind": "kanban_task", "task_id": "task_root_1"},
            },
            "timeline": {"run_id": "run_group_1", "latest_event_cursor": 5},
            "latest_route_decision": {"route_mode": "orchestration", "candidate_employee_ids": ["emp_2", "emp_3"]},
            "task_tree": {"items": []},
        }
    )
    assert "新建群聊" in payload["html"]
    assert "2×2 宫格" in payload["html"]
    assert "新增员工" in payload["html"]
    assert "踢出员工" in payload["html"]
    assert "解散群聊" in payload["html"]
    assert 'data-group-add-member' in payload["html"]
    assert 'data-group-remove-member' in payload["html"]
    assert 'data-group-archive' in payload["html"]
    assert 'disabled>新增员工' not in payload["html"]
    assert 'disabled>踢出员工' not in payload["html"]
    assert 'disabled>解散群聊' not in payload["html"]
    assert "当前正式写接口尚未开放" not in payload["html"]


def test_group_page_root_launcher_creates_group_and_loads_conversation() -> None:
    payload = _run_group_launcher_flow()
    assert payload["apiCalls"][0] == {"method": "GET", "path": "/api/team/employees"}
    assert payload["apiCalls"][1]["method"] == "POST"
    assert payload["apiCalls"][1]["path"] == "/api/team/group-conversations"
    assert payload["apiCalls"][1]["body"] == {"title": "预算评审群", "member_employee_ids": ["emp_member", "emp_planner"]}
    assert payload["apiCalls"][2] == {"method": "GET", "path": "/api/team/group-conversations/group_new"}
    assert "可选成员" in payload["launcherHtml"]
    assert "Alice" in payload["launcherHtml"]
    assert "Bob" in payload["launcherHtml"]
    assert "Cara" in payload["launcherHtml"]
    assert "已选成员：Alice、Bob" in payload["launcherHtml"]
    assert "已选成员：Bob、Cara" in payload["updatedLauncherHtml"]
    assert "新品启动群" in payload["html"]
    assert "成员管理" in payload["html"]


def test_group_page_launcher_enforces_ten_member_cap_with_visible_feedback() -> None:
    payload = _run_group_launcher_member_limit_flow()
    assert "当前已选 2 人" in payload["initialHtml"]
    assert "当前已选 10 人" in payload["tenSelectedHtml"]
    assert "已选成员：" in payload["tenSelectedHtml"]
    assert "成员10" in payload["tenSelectedHtml"]
    assert "已达 10 人上限" in payload["cappedHtml"]
    assert "当前已选 10 人" in payload["cappedHtml"]


def test_group_page_management_handlers_invoke_group_member_and_archive_apis() -> None:
    payload = _run_group_management_actions()
    assert payload["apiCalls"][0]["method"] == "POST"
    assert payload["apiCalls"][0]["path"] == "/api/team/group-conversations/group_ops/members"
    assert payload["apiCalls"][1]["method"] == "GET"
    assert payload["apiCalls"][2]["method"] == "DELETE"
    assert payload["apiCalls"][2]["path"] == "/api/team/group-conversations/group_ops/members/mem_member"
    assert payload["apiCalls"][3]["method"] == "GET"
    assert payload["apiCalls"][4]["method"] == "DELETE"
    assert payload["apiCalls"][4]["path"] == "/api/team/group-conversations/group_ops"
    assert "运营协作组" in payload["html"]
