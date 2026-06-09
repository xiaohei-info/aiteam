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
