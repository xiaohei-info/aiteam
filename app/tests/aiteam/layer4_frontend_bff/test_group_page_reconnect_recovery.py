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
        "SSE 恢复状态",
        "setRecoveryStatus('catching-up'",
        "setRecoveryStatus('reconnecting'",
        "setRecoveryStatus('resolved'",
        "setRecoveryStatus('error'",
        "已补齐断流期间事件，准备恢复实时流。",
        "实时协作流已恢复，不会重复补拉已消费事件。",
    ]:
        assert snippet in source, f"Missing reconnect recovery UX snippet: {snippet}"


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
context.window.aiteam.timeline.setCurrentCursor = function (cursor) {{ this._cursor = cursor; }};
context.window.aiteam.timeline.connect = function (runId, cursor, handlers) {{
  timelineConnects.push({{ runId, cursor }});
  handlers.onStatus({{ phase: 'reconnecting', cursor }});
  Promise.resolve(handlers.onReconnect({{ runId, cursor: 7 }})).then(function () {{
    handlers.onStatus({{ phase: 'live', cursor: 8 }});
    timelinePayloads.push({{ finalCursor: context.window.aiteam.timeline.getCurrentCursor ? context.window.aiteam.timeline.getCurrentCursor() : cursor }});
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
    collabText: collabStateEl.textContent,
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
    assert payload["recoveryLabel"] == "resolved"
    assert "实时协作流已恢复" in payload["recoveryText"]
    assert "cursor：8" in payload["collabText"]
    assert "结果合并" in payload["transcriptHtml"]
    assert "Bob" in payload["transcriptHtml"]
    assert "aiteam-message__avatar" in payload["transcriptHtml"]
    assert "cursor 8" in payload["timelineHtml"]
