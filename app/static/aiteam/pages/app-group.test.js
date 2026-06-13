'use strict';
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

// A permissive fake DOM node: every query returns another fake node and every
// method is a no-op, so renderGroup's binding pass never crashes in the VM.
function makeNode() {
  const node = {
    innerHTML: '',
    value: '',
    hidden: false,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
    scrollIntoView() {},
    querySelector() { return makeNode(); },
    querySelectorAll() { return []; },
  };
  return node;
}

function buildContext(testState) {
  const context = {
    window: {
      location: { pathname: '/app/group/conv_team', search: '' },
      history: { replaceState() {} },
      localStorage: { getItem() { return null; }, setItem() {} },
      aiteam: { util: { escapeHtml } },
    },
    document: { getElementById() { return null; }, createElement() { return makeNode(); } },
    console,
    setTimeout,
    clearTimeout,
  };
  context.window.aiteam.states = {
    renderLoading(container, message) { testState.loadingCalls.push(message); container.innerHTML = '<div>loading</div>'; },
    handleApiResult() { throw new Error('handleApiResult should not be called in success path'); },
  };
  context.window.aiteam.api = {
    getGroupConversation(id) {
      testState.getCalls.push(id);
      return Promise.resolve({ ok: true, data: { conversation_id: 'conv_team', title: '增长突击队', members: [], member_count: 2 } });
    },
    getWorkbench() {
      return Promise.resolve({
        ok: true,
        data: {
          employees: [],
          groups: [{ conversation_id: 'conv_team', title: '增长突击队', member_count: 2, unread_count: 4 }],
        },
      });
    },
    updateWorkbenchState(body) { testState.updateCalls.push(body); return Promise.resolve({ ok: true, data: {} }); },
  };
  context.global = context;
  context.globalThis = context;
  context.window.document = context.document;
  return context;
}

const code = fs.readFileSync(path.join(__dirname, 'app-group.js'), 'utf8');

test('opening a group conversation marks its unread count as read in workbench state', async function () {
  const testState = { getCalls: [], updateCalls: [], loadingCalls: [] };
  const context = buildContext(testState);
  vm.createContext(context);
  vm.runInContext(code, context);

  const page = context.window.aiteam.pages.appGroup;
  assert.ok(page && typeof page.init === 'function', 'appGroup page should expose init');

  const container = makeNode();
  page.init(container, { pathname: '/app/group/conv_team' });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });

  assert.ok(testState.getCalls.indexOf('conv_team') !== -1, 'group init should fetch the conversation');
  assert.strictEqual(testState.updateCalls.length, 1, 'group init should mark the opened conversation as read once');
  assert.strictEqual(testState.updateCalls[0].conversation_id, 'conv_team', 'group init should mark the opened group conversation id as read');
  assert.strictEqual(testState.updateCalls[0].mark_read, true, 'group init should set mark_read=true');
});

test('opening a group conversation with no unread does not call updateWorkbenchState', async function () {
  const testState = { getCalls: [], updateCalls: [], loadingCalls: [] };
  const context = buildContext(testState);
  context.window.aiteam.api.getWorkbench = function () {
    return Promise.resolve({
      ok: true,
      data: { employees: [], groups: [{ conversation_id: 'conv_team', title: '增长突击队', member_count: 2, unread_count: 0 }] },
    });
  };
  vm.createContext(context);
  vm.runInContext(code, context);

  const page = context.window.aiteam.pages.appGroup;
  const container = makeNode();
  page.init(container, { pathname: '/app/group/conv_team' });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });

  assert.strictEqual(testState.updateCalls.length, 0, 'no unread means no mark_read write');
});
