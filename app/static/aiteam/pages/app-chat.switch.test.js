'use strict';
// Regression tests for seamless in-page conversation switching (no full-page
// reload / flash when clicking a different employee in the agent list).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

const escapeHtml = function (v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
};

// A fake DOM node that memoizes children per selector, so the same selector
// returns the same node across queries (lets us inspect innerHTML after a swap).
function makeNode() {
  const cache = {};
  const attrs = {};
  const classes = new Set();
  const node = {
    innerHTML: '',
    value: '',
    hidden: false,
    scrollTop: 0,
    scrollHeight: 0,
    style: {},
    dataset: {},
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
      toggle() {},
    },
    _handlers: {},
    addEventListener(name, handler) { this._handlers[name] = handler; },
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return attrs[k] !== undefined ? attrs[k] : null; },
    focus() {},
    scrollIntoView() {},
    closest() { return null; },
    querySelector(sel) { if (!cache[sel]) cache[sel] = makeNode(); return cache[sel]; },
    querySelectorAll() { return []; },
  };
  return node;
}

function buildContext(state) {
  const context = {
    window: {
      location: {
        pathname: '/app/chat/conv_a',
        search: '',
        assign(p) { state.assignCalls.push(p); },
        get href() { return this.pathname; },
        set href(p) { state.assignCalls.push(p); },
      },
      history: { pushState(s, t, p) { state.pushCalls.push(p); }, replaceState() {} },
      addEventListener() {},
      aiteam: { util: { escapeHtml } },
    },
    document: { getElementById() { return null; }, createElement() { return makeNode(); } },
    console,
    setTimeout,
    clearTimeout,
  };
  context.window.aiteam.states = { renderLoading() {}, handleApiResult() {} };
  context.window.aiteam.timeline = { disconnect() { state.disconnectCalls += 1; }, connect() {}, getRunEvents() {} };
  context.window.aiteam.api = {
    get(p) {
      state.getCalls.push(p);
      return Promise.resolve({
        ok: true,
        data: {
          conversation_id: 'conv_b',
          employee_summary: { employee_id: 'emp_b', display_name: 'Bravo', role_name: '研究员' },
          messages: { items: [], next_cursor: 0, has_more: false },
          last_message_preview: { event_cursor: 0, preview: '' },
          latest_run: null,
        },
      });
    },
    getWorkbench() { state.workbenchCalls += 1; return Promise.resolve({ ok: true, data: { employees: [], groups: [] } }); },
    getRunEvents() { return Promise.resolve({ ok: true, data: { items: [] } }); },
    updateWorkbenchState(body) { state.updateCalls.push(body); return Promise.resolve({ ok: true, data: {} }); },
  };
  context.global = context;
  context.globalThis = context;
  context.window.document = context.document;
  return context;
}

const code = fs.readFileSync(path.join(__dirname, 'app-chat.js'), 'utf8');

function freshPage(state) {
  const context = buildContext(state);
  vm.createContext(context);
  vm.runInContext(code, context);
  return { page: context.window.aiteam.pages.appChat, context };
}

function newState() {
  return { getCalls: [], updateCalls: [], pushCalls: [], assignCalls: [], workbenchCalls: 0, disconnectCalls: 0 };
}

test('switching to another conversation swaps in place without a full reload or workbench refetch', async function () {
  const state = newState();
  const { page, context } = freshPage(state);

  const container = makeNode();
  container.__activeChatKey = 'conv_a';
  const main = container.querySelector('.aiteam-chatwin__main');

  page._switchConversation(container, '/app/chat/conv_b');
  await new Promise(function (r) { setTimeout(r, 0); });

  assert.deepStrictEqual(state.pushCalls, ['/app/chat/conv_b'], 'should push the new URL exactly once');
  assert.ok(state.getCalls.some(function (p) { return p.indexOf('conv_b') !== -1; }), 'should fetch the target conversation');
  assert.strictEqual(state.workbenchCalls, 0, 'should NOT refetch the workbench (left agent list stays put)');
  assert.strictEqual(state.disconnectCalls, 1, 'should tear down the previous conversation stream');
  assert.strictEqual(state.updateCalls.length, 1, 'should mark the opened conversation read');
  assert.strictEqual(state.updateCalls[0].conversation_id, 'conv_b');
  assert.strictEqual(state.updateCalls[0].mark_read, true);
  assert.strictEqual(state.assignCalls.length, 0, 'should never fall back to a full navigation on success');
  assert.ok(main.innerHTML.indexOf('Bravo') !== -1, 'the conversation pane should now show the new employee');
  assert.strictEqual(container.__activeChatKey, 'conv_b', 'active key should advance to the new conversation');
  void context;
});

test('clicking the already-open conversation is a no-op (no fetch, no history push)', async function () {
  const state = newState();
  const { page } = freshPage(state);

  const container = makeNode();
  container.__activeChatKey = 'conv_a';

  page._switchConversation(container, '/app/chat/conv_a');
  await new Promise(function (r) { setTimeout(r, 0); });

  assert.strictEqual(state.getCalls.length, 0, 'no conversation fetch for the active conversation');
  assert.strictEqual(state.pushCalls.length, 0, 'no history push for the active conversation');
  assert.strictEqual(state.updateCalls.length, 0, 'no read-state write for the active conversation');
});

test('a failed conversation fetch falls back to a real navigation (never strands the user)', async function () {
  const state = newState();
  const { page, context } = freshPage(state);
  context.window.aiteam.api.get = function (p) { state.getCalls.push(p); return Promise.resolve({ ok: false, status: 500 }); };

  const container = makeNode();
  container.__activeChatKey = 'conv_a';

  page._switchConversation(container, '/app/chat/conv_b');
  await new Promise(function (r) { setTimeout(r, 0); });

  assert.ok(state.assignCalls.indexOf('/app/chat/conv_b') !== -1, 'should hard-navigate to the target on fetch failure');
});

test('clicking the new-conversation action switches the current employee into draft mode', async function () {
  const state = newState();
  const { page } = freshPage(state);

  const container = makeNode();
  container.querySelector('[data-chat-new-conversation]');
  page.render(container, {
    conversation_id: 'conv_a',
    employee_summary: { employee_id: 'emp_a', display_name: 'Alpha', role_name: '顾问' },
    messages: { items: [], next_cursor: 0, has_more: false },
    last_message_preview: { event_cursor: 0, preview: '' },
    latest_run: null,
    __agentList: [{ employee_id: 'emp_a', display_name: 'Alpha', role_name: '顾问', conversation_id: 'conv_a' }],
  });

  const button = container.querySelector('[data-chat-new-conversation]');
  assert.ok(button && button._handlers && button._handlers.click, 'new conversation button should bind click handler');

  button._handlers.click({ preventDefault() {} });
  await new Promise(function (r) { setTimeout(r, 0); });

  assert.deepStrictEqual(state.pushCalls, ['/app/chat/emp_a'], 'should switch to the employee draft route');
  assert.strictEqual(state.workbenchCalls, 1, 'draft route should load workbench data once');
  assert.strictEqual(container.__activeChatKey, 'emp_a', 'active key should switch to the employee draft state');
  assert.strictEqual(state.assignCalls.length, 0, 'draft switch should stay in-place without full navigation');
});

test('command menu actions reuse the in-page new/retry/stop behaviours', async function () {
  const state = newState();
  const { page, context } = freshPage(state);

  const retries = [];
  const aborts = [];
  context.window.aiteam.api.get = function (p) {
    state.getCalls.push(p);
    return Promise.resolve({
      ok: true,
      data: {
        conversation_id: 'conv_a',
        employee_summary: { employee_id: 'emp_a', display_name: 'Alpha', role_name: '顾问' },
        messages: { items: [], next_cursor: 0, has_more: false },
        last_message_preview: { event_cursor: 0, preview: '' },
        latest_run: null,
      },
    });
  };
  context.window.aiteam.api.retryRun = function (runId, body) {
    retries.push({ runId, body });
    return Promise.resolve({ ok: true, data: { run_id: 'run_retry' } });
  };
  context.window.aiteam.api.abortRun = function (runId, body) {
    aborts.push({ runId, body });
    return Promise.resolve({ ok: true, data: { status: 'cancelled' } });
  };

  const container = makeNode();
  container.querySelector('[data-chat-command-new]');
  container.querySelector('[data-chat-command-retry]');
  container.querySelector('[data-chat-command-stop]');
  page.render(container, {
    conversation_id: 'conv_a',
    employee_summary: { employee_id: 'emp_a', display_name: 'Alpha', role_name: '顾问' },
    messages: { items: [], next_cursor: 0, has_more: false },
    last_message_preview: { event_cursor: 0, preview: '' },
    latest_run: { run_id: 'run_live', status: 'running' },
    __agentList: [{ employee_id: 'emp_a', display_name: 'Alpha', role_name: '顾问', conversation_id: 'conv_a' }],
  });

  const newBtn = container.querySelector('[data-chat-command-new]');
  const retryBtn = container.querySelector('[data-chat-command-retry]');
  const stopBtn = container.querySelector('[data-chat-command-stop]');
  assert.ok(newBtn && newBtn._handlers && newBtn._handlers.click, 'new command should bind click handler');
  assert.ok(retryBtn && retryBtn._handlers && retryBtn._handlers.click, 'retry command should bind click handler');
  assert.ok(stopBtn && stopBtn._handlers && stopBtn._handlers.click, 'stop command should bind click handler');

  retryBtn._handlers.click({ preventDefault() {} });
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.strictEqual(retries.length, 1, 'menu retry action should retry the latest run');
  assert.strictEqual(retries[0].runId, 'run_live');

  stopBtn._handlers.click({ preventDefault() {} });
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.strictEqual(aborts.length, 1, 'menu stop action should abort the active run');
  assert.strictEqual(aborts[0].runId, 'run_retry');

  newBtn._handlers.click({ preventDefault() {} });
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.deepStrictEqual(state.pushCalls, ['/app/chat/emp_a'], 'menu new action should switch to the employee draft route');
});
