'use strict';
// Regression tests for seamless in-page group conversation switching (no
// full-page reload / flash when clicking a different group in the left list).
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

// A fake DOM node that memoizes children per selector so the same selector
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
    removeChild(child) { if (child && child.parentNode === this) return child; return null; },
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return attrs[k] !== undefined ? attrs[k] : null; },
    focus() {},
    scrollIntoView() {},
    closest() { return null; },
    querySelector(sel) { if (!cache[sel]) cache[sel] = makeNode(); return cache[sel]; },
    querySelectorAll() { return []; },
    parentNode: null,
  };
  return node;
}

function buildContext(state) {
  const context = {
    window: {
      location: {
        pathname: '/app/group/conv_team_a',
        search: '',
        assign(p) { state.assignCalls.push(p); },
        get href() { return this.pathname; },
        set href(p) { state.assignCalls.push(p); },
      },
      history: { pushState(s, t, p) { state.pushCalls.push(p); }, replaceState() {} },
      addEventListener(name, handler) { state.popstateHandlers.push({ name, handler }); },
      localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      aiteam: { util: { escapeHtml } },
    },
    document: { getElementById() { return null; }, createElement() { return makeNode(); } },
    console,
    setTimeout,
    clearTimeout,
    Event: function (type, opts) { this.type = type; this.cancelable = opts && opts.cancelable; },
  };
  context.window.aiteam.states = { renderLoading() {}, handleApiResult() {} };
  context.window.aiteam.timeline = { disconnect() { state.disconnectCalls += 1; }, connect() {} };
  context.window.aiteam.api = {
    getGroupConversation(id) {
      state.getCalls.push(id);
      return Promise.resolve({
        ok: true,
        data: {
          conversation_id: 'conv_team_b',
          title: '增长突击队B',
          members: [],
          member_count: 3,
          default_route_hint: 'auto',
          latest_run: null,
          timeline: { latest_event_cursor: 0 },
        },
      });
    },
    getWorkbench() { state.workbenchCalls += 1; return Promise.resolve({ ok: true, data: { employees: [], groups: [] } }); },
    getRunEvents() { return Promise.resolve({ ok: true, data: { items: [] } }); },
    updateWorkbenchState(body) { state.updateCalls.push(body); return Promise.resolve({ ok: true, data: {} }); },
    submitGroupMessage() { return Promise.resolve({ ok: true, data: {} }); },
    abortRun() { return Promise.resolve({ ok: true, data: {} }); },
  };
  context.global = context;
  context.globalThis = context;
  context.window.document = context.document;
  return context;
}

const code = fs.readFileSync(path.join(__dirname, 'app-group.js'), 'utf8');

function freshPage(state) {
  const context = buildContext(state);
  vm.createContext(context);
  vm.runInContext(code, context);
  return { page: context.window.aiteam.pages.appGroup, context };
}

function newState() {
  return { getCalls: [], updateCalls: [], pushCalls: [], assignCalls: [], workbenchCalls: 0, disconnectCalls: 0, popstateHandlers: [] };
}

test('switching to another group conversation swaps in place without a full reload or workbench refetch', async function () {
  const state = newState();
  const { page, context } = freshPage(state);

  const container = makeNode();
  container.__activeGroupKey = 'conv_team_a';
  const main = container.querySelector('.aiteam-chatwin__main');
  const right = container.querySelector('.aiteam-chatwin__right');

  page._switchGroupConversation(container, '/app/group/conv_team_b');
  await new Promise(function (r) { setTimeout(r, 0); });

  assert.deepStrictEqual(state.pushCalls, ['/app/group/conv_team_b'], 'should push the new URL exactly once');
  assert.ok(state.getCalls.some(function (id) { return id === 'conv_team_b'; }), 'should fetch the target group conversation');
  assert.strictEqual(state.workbenchCalls, 0, 'should NOT refetch the workbench (left group list stays put)');
  assert.strictEqual(state.disconnectCalls, 1, 'should tear down the previous conversation stream');
  assert.strictEqual(state.updateCalls.length, 1, 'should mark the opened conversation read');
  assert.strictEqual(state.updateCalls[0].conversation_id, 'conv_team_b');
  assert.strictEqual(state.updateCalls[0].mark_read, true);
  assert.strictEqual(state.assignCalls.length, 0, 'should never fall back to a full navigation on success');
  assert.ok(main.innerHTML.indexOf('增长突击队B') !== -1, 'the main pane should now show the new group');
  assert.ok(right.innerHTML.indexOf('增长突击队B') !== -1, 'the right pane should now show the new group details');
  assert.strictEqual(container.__activeGroupKey, 'conv_team_b', 'active key should advance to the new conversation');
  void context;
});

test('clicking the already-open group conversation is a no-op (no fetch, no history push)', async function () {
  const state = newState();
  const { page } = freshPage(state);

  const container = makeNode();
  container.__activeGroupKey = 'conv_team_a';

  page._switchGroupConversation(container, '/app/group/conv_team_a');
  await new Promise(function (r) { setTimeout(r, 0); });

  assert.strictEqual(state.getCalls.length, 0, 'no conversation fetch for the active group');
  assert.strictEqual(state.pushCalls.length, 0, 'no history push for the active group');
  assert.strictEqual(state.updateCalls.length, 0, 'no read-state write for the active group');
});

test('a failed group conversation fetch falls back to a real navigation (never strands the user)', async function () {
  const state = newState();
  const { page, context } = freshPage(state);
  context.window.aiteam.api.getGroupConversation = function (id) { state.getCalls.push(id); return Promise.resolve({ ok: false, status: 500 }); };

  const container = makeNode();
  container.__activeGroupKey = 'conv_team_a';

  page._switchGroupConversation(container, '/app/group/conv_team_b');
  await new Promise(function (r) { setTimeout(r, 0); });

  assert.ok(state.assignCalls.indexOf('/app/group/conv_team_b') !== -1, 'should hard-navigate to the target on fetch failure');
});

test('swapGroupView falls back to renderGroup when shell elements are missing', async function () {
  const state = newState();
  const { page } = freshPage(state);

  // Container without shell elements — swapGroupView should fall back
  const container = makeNode();
  container.__activeGroupKey = 'conv_team_a';

  // Force querySelector to return null for shell selectors
  const origQuerySelector = container.querySelector;
  container.querySelector = function (sel) {
    if (sel === '.aiteam-chatwin__main' || sel === '.aiteam-chatwin__right') return null;
    return origQuerySelector(sel);
  };

  page._swapGroupView(container, { conversation_id: 'conv_team_b', title: '测试群', members: [], member_count: 2, default_route_hint: 'auto' });
  await new Promise(function (r) { setTimeout(r, 0); });

  assert.strictEqual(container.__activeGroupKey, 'conv_team_b', 'active key should update even on fallback');
});

test('the workbench/agent list is NOT refetched on switch', async function () {
  const state = newState();
  const { page } = freshPage(state);

  const container = makeNode();
  container.__activeGroupKey = 'conv_team_a';

  page._switchGroupConversation(container, '/app/group/conv_team_b');
  await new Promise(function (r) { setTimeout(r, 0); });

  assert.strictEqual(state.workbenchCalls, 0, 'switching should not call getWorkbench');
});
