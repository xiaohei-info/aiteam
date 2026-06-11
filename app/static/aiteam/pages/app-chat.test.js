'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

const context = {
  window: { aiteam: { util: { escapeHtml: function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]; }); } } } },
  document: { getElementById() { return null; } },
  console, setTimeout, clearTimeout,
};
context.global = context; context.globalThis = context;
const code = fs.readFileSync(path.join(__dirname, 'app-chat.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);
const ns = context.window.aiteam;
const page = ns.pages && ns.pages.appChat;

function makeContainer() {
  // minimal element with innerHTML setter + no-op querySelector chain used by bindChat
  const el = {
    innerHTML: '',
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  return el;
}

test('chat renders agent list in left column', function () {
  assert.ok(page, 'appChat page should register');
  assert.strictEqual(typeof page._renderChat, 'function', 'expected _renderChat test export');
  const conversation = {
    conversation_id: 'c-1',
    display_state: 'idle',
    employee_summary: { employee_id: 'e-1', display_name: '小析', role_name: '营销分析师', model_provider: 'openrouter', model_name: 'gpt' },
    messages: { items: [], next_cursor: 0, has_more: false },
    __agentList: [
      { employee_id: 'e-1', display_name: '小析', role_name: '营销分析师', status: 'online', conversation_id: 'c-1', avatar: '🤖', unread_count: 2, time_label: '10:24' },
      { employee_id: 'e-2', display_name: '小创', role_name: '内容创作', status: 'busy', conversation_id: 'c-2', avatar: '✍️' },
    ],
  };
  const container = makeContainer();
  page._renderChat(container, conversation);
  assert.ok(container.innerHTML.includes('aiteam-chat__agent-list'), 'expected agent list container');
  assert.ok(container.innerHTML.includes('aiteam-chat__agent'), 'expected agent item');
  assert.ok(container.innerHTML.includes('小析'), 'expected agent name rendered');
  assert.ok(container.innerHTML.includes('/app/chat/c-2'), 'expected nav href to other conversation');
});

test('chat renders tool card for tool_call timeline item', function () {
  const html = page._renderTimelineItem({ type: 'tool_call', tool_name: 'web_search', tool_args: '"AI"' });
  assert.ok(html.includes('aiteam-chat__tool-card'), 'expected tool card');
  assert.ok(html.includes('web_search'), 'expected tool name');
});
test('chat renders thinking bubble', function () {
  const html = page._renderThinking();
  assert.ok(html.includes('aiteam-chat__thinking'), 'expected thinking bubble');
});
test('chat summary panel keeps real bindings (skills + model)', function () {
  const html = page._renderSummaryPanel({ display_name: '小析', role_name: '分析师', model_provider: 'openrouter', model_name: 'gpt', skills: ['检索','写作'], knowledge_bases: ['KB1'], usage_summary: { total_runs: 4, status_counts: { succeeded: 3 } } }, { message_count: 9 });
  assert.ok(html.includes('小析'), 'name');
  assert.ok(html.includes('检索'), 'skill chip preserved (real binding)');
  assert.ok(html.includes('gpt'), 'model preserved (real binding)');
});
