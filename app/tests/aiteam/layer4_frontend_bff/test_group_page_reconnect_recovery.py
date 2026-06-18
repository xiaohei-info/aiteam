from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
GROUP_PAGE_PATH = ROOT / "static" / "aiteam" / "pages" / "app-group.js"
TIMELINE_CLIENT_PATH = ROOT / "static" / "aiteam" / "timeline-client.js"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_group_page_reconnect_flow_declares_visible_recovery_states() -> None:
    source = _read(GROUP_PAGE_PATH)
    for snippet in [
        "data-group-recovery",
        "setRecoveryStatus('catching-up'",
        "setRecoveryStatus('reconnecting'",
        "setRecoveryStatus('resolved'",
        "setRecoveryStatus('error'",
        "已补齐断流期间事件，准备恢复实时流。",
        "实时协作已恢复。",
    ]:
        assert snippet in source, f"Missing reconnect recovery UX snippet: {snippet}"


def test_group_page_primary_button_reverts_to_send_on_stream_end() -> None:
    # Live collaboration streams only signal completion with `stream_end`; the
    # group primary button must revert on that signal even if the reloaded run
    # status is still 'running' (control-plane lag).
    script = f"""
const fs = require('fs');
const vm = require('vm');
const timelineSource = fs.readFileSync({json.dumps(str(TIMELINE_CLIENT_PATH))}, 'utf8');
const pageSource = fs.readFileSync({json.dumps(str(GROUP_PAGE_PATH))}, 'utf8');

function el() {{ return {{ innerHTML: '', textContent: '' }}; }}
const statusEl = {{ textContent: '' }};
const collabStateEl = {{ innerHTML: '', hidden: false }};
const mentionStateEl = {{ innerHTML: '', textContent: '', hidden: false }};
const primaryBtn = {{
  textContent: '➤',
  title: '',
  dataset: {{}},
  classList: {{ values: new Set(),
    toggle(name, on) {{ if (on) this.values.add(name); else this.values.delete(name); }},
    contains(name) {{ return this.values.has(name); }} }},
  setAttribute() {{}},
  addEventListener() {{}},
}};
const senderInput = {{ value: 'user_1', addEventListener() {{}}, focus() {{}} }};
const routeSelect = {{ value: 'auto', addEventListener() {{}} }};
const input = {{ value: '', focus() {{}} }};
const form = {{ addEventListener() {{}} }};
const noop = {{ addEventListener() {{}}, scrollIntoView() {{}} }};
const container = {{
  innerHTML: '',
  querySelector(selector) {{
    const map = {{
      '[data-group-transcript]': el(), '[data-group-timeline]': el(),
      '[data-group-task-tree]': el(), '[data-group-members]': el(),
      '[data-group-mention-strip]': el(), '[data-group-status]': statusEl,
      '[data-group-input]': input, '[data-group-route]': routeSelect,
      '[data-group-sender]': senderInput, '[data-group-settings-card]': noop,
      '[data-group-route-mode]': el(), '[data-group-route-desc]': el(),
      '[data-group-route-targets]': el(), '[data-group-runtime-handle]': el(),
      '[data-group-mention-state]': mentionStateEl, '[data-group-collab-state]': collabStateEl,
      '[data-group-recovery-label]': el(), '[data-group-recovery]': el(),
      '[data-group-form]': form, '[data-group-reconnect]': noop,
      '[data-group-open-settings]': noop, '[data-group-primary]': primaryBtn,
    }};
    return map[selector] || null;
  }},
  querySelectorAll() {{ return []; }},
}};
const context = {{
  window: {{ location: {{ pathname: '/app/group/group_1', href: 'http://example.test/app/group/group_1' }} }},
  document: {{ baseURI: 'http://example.test/app/group/group_1' }},
  console, EventSource: function () {{}}, setTimeout, clearTimeout,
}};
context.window.window = context.window;
context.window.document = context.document;
context.window.aiteam = {{
  util: {{ escapeHtml: (value) => String(value == null ? '' : value) }},
  states: {{ renderError() {{}}, renderLoading() {{}}, handleApiResult() {{}} }},
  api: {{
    getRunEvents() {{
      // Always report a stale 'running' status to prove the button reverts on
      // stream_end regardless of the reloaded control-plane status.
      return Promise.resolve({{ ok: true, data: {{ items: [], next_cursor: 5, latest_event_cursor: 5, run_status: 'running' }} }});
    }},
  }},
}};
context.window.localStorage = {{ getItem() {{ return ''; }}, setItem() {{}}, removeItem() {{}} }};
context.globalThis = context.window;
vm.createContext(context.window);
vm.runInContext(timelineSource, context.window);
let captured = null;
context.window.aiteam.timeline.disconnect = function () {{}};
context.window.aiteam.timeline.connect = function (runId, cursor, onEvent, handlers) {{ captured = handlers; }};
vm.runInContext(pageSource, context.window);
const conversation = {{
  conversation_id: 'group_1', title: '测试群聊', display_state: 'busy', default_route_hint: 'auto',
  member_count: 2,
  members: [
    {{ employee_id: 'emp_1', display_name: 'Alice', role_name: '产品经理' }},
    {{ employee_id: 'emp_2', display_name: 'Bob', role_name: '工程师' }},
  ],
  latest_run: {{ run_id: 'run_group_1', status: 'running', latest_event_cursor: 5 }},
  timeline: {{ run_id: 'run_group_1', latest_event_cursor: 5 }},
  latest_route_decision: {{ route_mode: 'orchestration', candidate_employee_ids: ['emp_2'] }},
  task_tree: {{ items: [] }},
}};
context.window.aiteam.pages.appGroup.render(container, conversation);
Promise.resolve().then(() => new Promise((r) => setTimeout(r, 0))).then(() => new Promise((r) => setTimeout(r, 0))).then(() => {{
  const before = {{ action: primaryBtn.dataset.action, text: primaryBtn.textContent }};
  if (captured && typeof captured.onStreamEnd === 'function') {{ captured.onStreamEnd(); }}
  return new Promise((r) => setTimeout(r, 0)).then(() => {{
    console.log(JSON.stringify({{
      hadOnStreamEnd: !!(captured && typeof captured.onStreamEnd === 'function'),
      beforeAction: before.action,
      afterAction: primaryBtn.dataset.action,
      afterText: primaryBtn.textContent,
      afterIsStop: primaryBtn.classList.contains('is-stop'),
    }}));
  }});
}}).catch((error) => {{ console.error(error && error.stack ? error.stack : error); process.exit(1); }});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    payload = json.loads(completed.stdout)
    assert payload["hadOnStreamEnd"] is True
    assert payload["beforeAction"] == "stop"
    assert payload["afterAction"] == "send"
    assert payload["afterText"] == "➤"
    assert payload["afterIsStop"] is False


def test_group_page_reconnect_flow_uses_cursor_based_catch_up() -> None:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const timelineSource = fs.readFileSync({json.dumps(str(TIMELINE_CLIENT_PATH))}, 'utf8');
const pageSource = fs.readFileSync({json.dumps(str(GROUP_PAGE_PATH))}, 'utf8');
const recoveryStatuses = [];
const timelineConnects = [];
const timelineDisconnects = [];
const historyRequests = [];
const timelinePayloads = [];
const transcriptEl = {{ innerHTML: '' }};
const timelineEl = {{ innerHTML: '' }};
const taskTreeEl = {{ innerHTML: '' }};
const membersEl = {{ innerHTML: '' }};
const mentionStripEl = {{ innerHTML: '' }};
const statusEl = {{ textContent: '' }};
const routeModeEl = {{ textContent: '' }};
const routeDescEl = {{ textContent: '' }};
const routeTargetsEl = {{ innerHTML: '' }};
const runtimeHandleEl = {{ innerHTML: '' }};
const mentionStateEl = {{ innerHTML: '' }};
const collabStateEl = {{ textContent: '' }};
const recoveryLabelEl = {{ textContent: '' }};
const recoveryEl = {{ textContent: '' }};
const senderInput = {{
  value: 'user_1',
  addEventListener() {{}},
  focus() {{}},
}};
const routeSelect = {{
  value: 'auto',
  addEventListener() {{}},
}};
const input = {{ value: '', focus() {{}} }};
const form = {{ addEventListener(type, fn) {{ this.submit = fn; }} }};
const reconnectBtn = {{ addEventListener(type, fn) {{ this.click = fn; }} }};
const settingsBtn = {{ addEventListener() {{}} }};
const settingsCard = {{ scrollIntoView() {{}} }};
const buttons = [];
const container = {{
  innerHTML: '',
  querySelector(selector) {{
    const map = {{
      '[data-group-transcript]': transcriptEl,
      '[data-group-timeline]': timelineEl,
      '[data-group-task-tree]': taskTreeEl,
      '[data-group-members]': membersEl,
      '[data-group-mention-strip]': mentionStripEl,
      '[data-group-status]': statusEl,
      '[data-group-input]': input,
      '[data-group-route]': routeSelect,
      '[data-group-sender]': senderInput,
      '[data-group-settings-card]': settingsCard,
      '[data-group-route-mode]': routeModeEl,
      '[data-group-route-desc]': routeDescEl,
      '[data-group-route-targets]': routeTargetsEl,
      '[data-group-runtime-handle]': runtimeHandleEl,
      '[data-group-mention-state]': mentionStateEl,
      '[data-group-collab-state]': collabStateEl,
      '[data-group-recovery-label]': recoveryLabelEl,
      '[data-group-recovery]': recoveryEl,
      '[data-group-form]': form,
      '[data-group-reconnect]': reconnectBtn,
      '[data-group-open-settings]': settingsBtn,
    }};
    return map[selector] || null;
  }},
  querySelectorAll(selector) {{
    if (selector === '[data-mention]') return buttons;
    return [];
  }},
}};
const context = {{
  window: {{ location: {{ pathname: '/app/group/group_1', href: 'http://example.test/app/group/group_1' }} }},
  document: {{ baseURI: 'http://example.test/app/group/group_1' }},
  console,
  EventSource: function () {{}},
  setTimeout,
  clearTimeout,
}};
context.window.window = context.window;
context.window.document = context.document;
context.window.aiteam = {{
  util: {{ escapeHtml: (value) => String(value == null ? '' : value) }},
  states: {{
    renderError() {{}},
    renderLoading() {{}},
    handleApiResult() {{}},
  }},
  api: {{
    getRunEvents(runId, cursor) {{
      historyRequests.push({{ runId, cursor }});
      if (historyRequests.length === 1) {{
        return Promise.resolve({{
          ok: true,
          data: {{
            items: [
              {{ event_cursor: 6, event_type: 'task_started', payload: {{ phase: 'planner' }}, preview: '任务开始' }},
              {{ event_cursor: 7, event_type: 'result_merged', payload: {{ employee_id: 'emp_2' }}, preview: '结果合并' }},
            ],
            next_cursor: 7,
            latest_event_cursor: 7,
            run_status: 'running',
          }},
        }});
      }}
      return Promise.resolve({{
        ok: true,
        data: {{
          items: [
            {{ event_cursor: 8, event_type: 'run_succeeded', payload: {{}}, preview: '运行完成' }},
          ],
          next_cursor: 8,
          latest_event_cursor: 8,
          run_status: 'succeeded',
        }},
      }});
    }},
  }},
}};
context.window.localStorage = {{ getItem() {{ return ''; }}, setItem() {{}}, removeItem() {{}} }};
context.globalThis = context.window;
vm.createContext(context.window);
vm.runInContext(timelineSource, context.window);
context.window.aiteam.timeline.disconnect = function () {{ timelineDisconnects.push('disconnect'); }};
// 共享契约：connect(runId, cursor, onEvent, {{ onOpen, onReconnect }})
context.window.aiteam.timeline.connect = function (runId, cursor, onEvent, handlers) {{
  timelineConnects.push({{ runId, cursor }});
  Promise.resolve(handlers.onReconnect(7)).then(function () {{
    handlers.onOpen(8);
    timelinePayloads.push({{ finalCursor: cursor }});
  }});
}};
vm.runInContext(pageSource, context.window);
const conversation = {{
  conversation_id: 'group_1',
  title: '测试群聊',
  display_state: 'busy',
  default_route_hint: 'auto',
  member_count: 2,
  members: [
    {{ employee_id: 'emp_1', display_name: 'Alice', role_name: '产品经理' }},
    {{ employee_id: 'emp_2', display_name: 'Bob', role_name: '工程师' }},
  ],
  latest_run: {{
    run_id: 'run_group_1',
    status: 'running',
    latest_event_cursor: 5,
    runtime_handle: {{ kind: 'kanban_task', task_id: 'task_root_1' }},
  }},
  timeline: {{ run_id: 'run_group_1', latest_event_cursor: 5 }},
  latest_route_decision: {{ route_mode: 'orchestration', candidate_employee_ids: ['emp_2'] }},
  task_tree: {{ items: [] }},
}};
context.window.aiteam.pages.appGroup.render(container, conversation);
Promise.resolve().then(() => new Promise((resolve) => setTimeout(resolve, 0))).then(() => {{
  recoveryStatuses.push(recoveryLabelEl.textContent);
  recoveryStatuses.push(recoveryEl.textContent);
  console.log(JSON.stringify({{
    historyRequests,
    timelineConnects,
    timelineDisconnects: timelineDisconnects.length,
    recoveryLabel: recoveryLabelEl.textContent,
    recoveryText: recoveryEl.textContent,
    collabText: collabStateEl.innerHTML || '',
    transcriptHtml: transcriptEl.innerHTML,
    timelineHtml: timelineEl.innerHTML,
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
    assert payload["historyRequests"] == [
        {"runId": "run_group_1", "cursor": 5},
        {"runId": "run_group_1", "cursor": 7},
    ]
    assert payload["timelineConnects"] == [{"runId": "run_group_1", "cursor": 7}]
    assert payload["timelineDisconnects"] == 1
    assert "实时协作已恢复" in payload["recoveryText"]
    assert "已完成" in payload["collabText"]
    assert "结果合并" in payload["transcriptHtml"]
    assert "Bob" in payload["transcriptHtml"]
    assert "aiteam-message__avatar" in payload["transcriptHtml"]
    assert "运行完成" in payload["timelineHtml"]
