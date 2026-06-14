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
test('chat renders reasoning timeline item', function () {
  const html = page._renderTimelineItem({ type: 'reasoning', text: '需要先查知识库。' });
  assert.ok(html.includes('aiteam-chat__reasoning-card'), 'expected reasoning card');
  assert.ok(html.includes('需要先查知识库。'), 'expected reasoning text');
});
test('chat renders reasoning timeline item from history', function () {
  const conversation = {
    conversation_id: 'c-reasoning',
    employee_summary: { employee_id: 'e-1', display_name: '小析' },
    messages: {
      items: [
        {
          message_id: 'm-reasoning',
          role: 'system',
          created_at: '2026-06-14T07:00:00Z',
          __timeline_item: {
            kind: 'reasoning',
            payload: { delta: '需要先查知识库。', kind: 'reasoning' },
          },
        },
      ],
      next_cursor: 1,
      has_more: false,
    },
  };
  const transcript = { innerHTML: '' };
  const container = {
    innerHTML: '',
    querySelector(selector) { return selector === '[data-chat-transcript]' ? transcript : null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  page._renderChat(container, conversation);
  assert.ok(transcript.innerHTML.includes('aiteam-chat__reasoning-card'), 'expected reasoning card in history');
  assert.ok(transcript.innerHTML.includes('需要先查知识库。'), 'expected reasoning text in history');
});

test('reasoning deltas accumulate into a single bubble instead of splitting per token', function () {
  // Simulate multiple message_delta events with kind=reasoning arriving in sequence.
  // Before the fix each delta created a separate liveItem → multiple "思考过程" cards.
  // After the fix all deltas accumulate into one reasoning bubble.
  const state = {
    liveItems: [],
    streamingAssistantText: '',
    cursor: 0,
    isSyncing: false,
    hasLiveDelta: false,
    latestEventType: '',
    statusText: '',
  };

  // Delta 1: "用户"
  page._applyTimelineEvent(state, { event_type: 'message_delta', event_cursor: 1, payload: { delta: '用户', kind: 'reasoning' } });
  assert.strictEqual(state.liveItems.length, 1, 'first reasoning delta should create one live item');

  // Delta 2: "用中文"
  page._applyTimelineEvent(state, { event_type: 'message_delta', event_cursor: 2, payload: { delta: '用中文', kind: 'reasoning' } });
  assert.strictEqual(state.liveItems.length, 1, 'second reasoning delta should accumulate into the same live item, not create a new one');

  // Delta 3: "打招呼"
  page._applyTimelineEvent(state, { event_type: 'message_delta', event_cursor: 3, payload: { delta: '打招呼', kind: 'reasoning' } });
  assert.strictEqual(state.liveItems.length, 1, 'third reasoning delta should also accumulate into the single live item');

  // The single live item should contain the full accumulated text.
  var reasoningItem = state.liveItems[0];
  assert.strictEqual(reasoningItem.kind, 'reasoning');
  assert.strictEqual(reasoningItem.payload.delta, '用户用中文打招呼', 'accumulated delta should be the concatenation of all three deltas');

  // Render the accumulated reasoning via renderTimelineItem
  var html = page._renderTimelineItem({ type: 'reasoning', text: reasoningItem.payload.delta });
  assert.ok(html.includes('用户用中文打招呼'), 'rendered reasoning card should contain full accumulated text');
  var cardCount = (html.match(/aiteam-chat__reasoning-card/g) || []).length;
  assert.strictEqual(cardCount, 1, 'rendered HTML should contain exactly one reasoning card');
});
test('chat summary panel keeps real bindings (skills + model)', function () {
  const html = page._renderSummaryPanel({ display_name: '小析', role_name: '分析师', model_provider: 'openrouter', model_name: 'gpt', skills: ['检索','写作'], knowledge_bases: ['KB1'], usage_summary: { total_runs: 4, status_counts: { succeeded: 3 } } }, { message_count: 9 });
  assert.ok(html.includes('小析'), 'name');
  assert.ok(html.includes('检索'), 'skill chip preserved (real binding)');
  assert.ok(html.includes('gpt'), 'model preserved (real binding)');
});

test('agent list renders demo three sections (pinned / groups / others)', function () {
  assert.strictEqual(typeof page._renderAgentList, 'function', 'expected _renderAgentList test export');
  const html = page._renderAgentList({
    pinned: [
      { employee_id: 'p1', display_name: 'Luna', role_name: '策略分析师', status: 'online', conversation_id: 'c-luna', unread_count: 2, time_label: '刚刚' },
    ],
    groups: [
      { conversation_id: 'g1', title: '产品研发组', member_count: 5, running_count: 2, status: 'online', time_label: '5分钟' },
    ],
    others: [
      { employee_id: 'o1', display_name: 'Nova', role_name: '数据科学家', status: 'offline', conversation_id: 'c-nova' },
    ],
  }, 'c-luna');
  assert.ok(html.includes('📌 置顶'), 'expected pinned section label');
  assert.ok(html.includes('💼 工作群组'), 'expected groups section label');
  assert.ok(html.includes('🤖 其他智能体'), 'expected others section label');
  assert.ok(html.includes('Luna'), 'pinned agent rendered');
  assert.ok(html.includes('产品研发组'), 'group rendered');
  assert.ok(html.includes('/app/group/g1'), 'group href points to group route');
  assert.ok(html.includes('Nova'), 'other agent rendered');
  assert.ok(html.includes('is-active'), 'active conversation highlighted');
});

function makeCapturingContainer() {
  // querySelector returns a per-selector capturing stub so bindChat's refs work
  // and we can inspect what renderTranscript wrote.
  const els = {};
  function stub() {
    return { innerHTML: '', textContent: '', scrollTop: 0, scrollHeight: 0,
      addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
  }
  const c = {
    innerHTML: '', addEventListener() {}, querySelectorAll() { return []; },
    querySelector(sel) { if (!els[sel]) els[sel] = stub(); return els[sel]; },
    _els: els,
  };
  return c;
}

test('stale terminal run loaded from history shows no thinking bubble', function () {
  const c = makeCapturingContainer();
  page._renderChat(c, {
    conversation_id: 'c_stale',
    display_state: 'resolved', // not an active state → no live sync
    employee_summary: { employee_id: 'e1', display_name: '小析' },
    messages: { items: [{ role: 'user', text: '你好', created_at: '2026-01-01T00:00:00Z' }], next_cursor: 0, has_more: false },
    latest_run: { run_id: 'run_stale', status: 'succeeded' }, // stale runId in history
    __agentList: [{ employee_id: 'e1', display_name: '小析', conversation_id: 'c_stale' }],
  });
  const transcript = c._els['[data-chat-transcript]'].innerHTML;
  assert.ok(transcript.indexOf('你好') !== -1, 'history message should render');
  assert.ok(transcript.indexOf('正在思考中') === -1, 'stale run must not show a permanent thinking bubble');
});

test('draft chat highlights employee with no conversation by employee_id', function () {
  const html = page._renderAgentList({
    pinned: [], groups: [],
    others: [
      { employee_id: 'emp_new', display_name: '产品顾问', role_name: '顾问', status: 'online' }, // no conversation_id yet
    ],
  }, 'emp_new');
  assert.ok(html.includes('is-active'), 'draft employee highlighted by employee_id');
  assert.ok(html.includes('/app/chat/emp_new'), 'draft href uses employee id');
});

test('draft conversation renders empty chat window with composer', function () {
  const container = makeContainer();
  page._renderChat(container, {
    conversation_id: '',
    employee_summary: { employee_id: 'emp_new', display_name: '产品顾问', role_name: '顾问' },
    messages: { items: [], next_cursor: 0, has_more: false },
    latest_run: null,
    __draft_employee_id: 'emp_new',
    __agentList: [{ employee_id: 'emp_new', display_name: '产品顾问', role_name: '顾问', status: 'online' }],
  });
  assert.ok(container.innerHTML.includes('产品顾问'), 'employee name rendered in draft');
  assert.ok(container.innerHTML.includes('data-chat-form'), 'composer rendered for draft');
  assert.ok(container.innerHTML.includes('is-active'), 'draft employee highlighted in list');
});

test('chat header exposes a new-conversation action for the current employee', function () {
  const container = makeContainer();
  page._renderChat(container, {
    conversation_id: 'conv_existing',
    employee_summary: { employee_id: 'emp_existing', display_name: '产品顾问', role_name: '顾问' },
    messages: { items: [], next_cursor: 0, has_more: false },
    latest_run: null,
    __agentList: [{ employee_id: 'emp_existing', display_name: '产品顾问', role_name: '顾问', status: 'online', conversation_id: 'conv_existing' }],
  });
  assert.ok(container.innerHTML.includes('data-chat-new-conversation'), 'new conversation action rendered');
});

test('chat renders a command menu with supported product actions', function () {
  const container = makeContainer();
  page._renderChat(container, {
    conversation_id: 'conv_existing',
    employee_summary: { employee_id: 'emp_existing', display_name: '产品顾问', role_name: '顾问' },
    messages: { items: [], next_cursor: 0, has_more: false },
    latest_run: { run_id: 'run_existing', status: 'running' },
    __agentList: [{ employee_id: 'emp_existing', display_name: '产品顾问', role_name: '顾问', status: 'online', conversation_id: 'conv_existing' }],
  });
  assert.ok(container.innerHTML.includes('data-chat-command-menu'), 'command menu rendered');
  assert.ok(container.innerHTML.includes('data-chat-command-new'), 'new command exposed');
  assert.ok(container.innerHTML.includes('data-chat-command-retry'), 'retry command exposed');
  assert.ok(container.innerHTML.includes('data-chat-command-stop'), 'stop command exposed');
});

test('agent list skips empty sections', function () {
  const html = page._renderAgentList({
    pinned: [],
    groups: [],
    others: [{ employee_id: 'o1', display_name: 'Nova', role_name: '数据科学家', status: 'online', conversation_id: 'c-nova' }],
  }, '');
  assert.ok(!html.includes('📌 置顶'), 'no pinned label when empty');
  assert.ok(!html.includes('💼 工作群组'), 'no groups label when empty');
  assert.ok(html.includes('🤖 其他智能体'), 'others label present');
});

test('landing renders agent list and empty-state prompt without conversation', function () {
  assert.strictEqual(typeof page._renderLanding, 'function', 'expected _renderLanding test export');
  const container = makeContainer();
  page._renderLanding(container, {
    employees: [
      { employee_id: 'e1', display_name: 'Luna', role_name: '策略分析师', presence: 'online', conversation_id: 'c-luna', pinned: true },
      { employee_id: 'e2', display_name: 'Nova', role_name: '数据科学家', presence: 'idle', conversation_id: 'c-nova' },
    ],
    groups: [{ conversation_id: 'g1', title: '产品研发组', member_count: 5, running_count: 2 }],
  });
  assert.ok(container.innerHTML.includes('aiteam-chat__agent-list'), 'expected agent list container');
  assert.ok(container.innerHTML.includes('📌 置顶'), 'pinned classified from workbench data');
  assert.ok(container.innerHTML.includes('💼 工作群组'), 'groups rendered on landing');
  assert.ok(container.innerHTML.includes('Nova'), 'unpinned employee in others');
  assert.ok(container.innerHTML.includes('选择'), 'expected empty-state prompt to pick a conversation');
});

test('opening a concrete conversation marks its unread count as read in workbench state', async function () {
  var getCalls = [];
  var updateCalls = [];
  var loadingCalls = [];
  var testContext = {
    window: {
      location: { pathname: '/app/chat/conv_luna', search: '' },
      history: { replaceState() {} },
      aiteam: {
        util: context.window.aiteam.util,
        states: {
          renderLoading(container, message) {
            loadingCalls.push(message);
            container.innerHTML = '<div>loading</div>';
          },
          handleApiResult() {
            throw new Error('handleApiResult should not be called in success path');
          },
        },
        api: {
          get(path) {
            getCalls.push(path);
            return Promise.resolve({
              ok: true,
              data: {
                conversation_id: 'conv_luna',
                display_state: 'idle',
                employee_summary: { employee_id: 'emp_luna', display_name: 'Luna', role_name: '策略分析师' },
                messages: { items: [], next_cursor: 0, has_more: false },
                last_message_preview: { event_cursor: 0, preview: '' },
                latest_run: null,
              },
            });
          },
          getWorkbench() {
            return Promise.resolve({
              ok: true,
              data: {
                employees: [
                  {
                    employee_id: 'emp_luna',
                    display_name: 'Luna',
                    role_name: '策略分析师',
                    conversation_id: 'conv_luna',
                    unread_count: 3,
                    pinned: true,
                  },
                ],
                groups: [],
              },
            });
          },
          updateWorkbenchState(body) {
            updateCalls.push(body);
            return Promise.resolve({ ok: true, data: {} });
          },
        },
      },
    },
    document: { getElementById() { return null; } },
    console,
    setTimeout,
    clearTimeout,
  };
  testContext.global = testContext;
  testContext.globalThis = testContext;
  testContext.window.document = testContext.document;
  vm.createContext(testContext);
  vm.runInContext(code, testContext);

  var testPage = testContext.window.aiteam.pages.appChat;
  var container = makeContainer();
  testPage.init(container, { pathname: '/app/chat/conv_luna' });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });

  assert.ok(loadingCalls.length >= 1, 'chat init should render a loading state');
  assert.ok(getCalls.some(function (path) { return path.indexOf('/conversations/conv_luna') !== -1; }), 'chat init should fetch the conversation');
  assert.strictEqual(updateCalls.length, 1, 'chat init should mark the opened conversation as read once');
  assert.strictEqual(updateCalls[0].conversation_id, 'conv_luna', 'chat init should mark the opened conversation id as read');
  assert.strictEqual(updateCalls[0].mark_read, true, 'chat init should set mark_read=true');
});
