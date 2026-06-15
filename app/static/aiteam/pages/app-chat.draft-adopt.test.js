'use strict';
// Reproduction: 新建会话(draft) → 发送首条消息 → 服务端懒创建新会话 →
// 前端应把 URL 收敛到新会话；刷新后仍停留在新会话而不是旧会话。
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

function makeNode() {
  const cache = {};
  const attrs = {};
  const classes = new Set();
  const node = {
    innerHTML: '', value: '', hidden: false, scrollTop: 0, scrollHeight: 0,
    style: {}, dataset: {},
    classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); }, toggle() {} },
    _handlers: {},
    addEventListener(name, handler) { this._handlers[name] = handler; },
    removeEventListener() {},
    appendChild() {}, removeChild() {},
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return attrs[k] !== undefined ? attrs[k] : null; },
    focus() {}, scrollIntoView() {},
    closest() { return null; },
    querySelector(sel) { if (!cache[sel]) cache[sel] = makeNode(); return cache[sel]; },
    querySelectorAll() { return []; },
  };
  return node;
}

function buildContext(state) {
  const location = {
    pathname: '/app/chat/conv_old',
    search: '',
    assign(p) { state.assignCalls.push(p); this.pathname = String(p).split('?')[0]; },
    get href() { return this.pathname; },
    set href(p) { state.assignCalls.push(p); },
  };
  const context = {
    window: {
      location,
      history: {
        pushState(s, t, p) { state.pushCalls.push(p); location.pathname = String(p).split('?')[0]; },
        replaceState(s, t, p) { state.replaceCalls.push(p); location.pathname = String(p).split('?')[0]; },
      },
      addEventListener() {},
      aiteam: { util: { escapeHtml } },
    },
    document: { getElementById() { return null; }, createElement() { return makeNode(); } },
    console, setTimeout, clearTimeout,
  };
  context.window.aiteam.states = { renderLoading() {}, handleApiResult() {} };
  context.window.aiteam.timeline = { disconnect() {}, connect() {}, getRunEvents() {} };
  context.window.aiteam.api = {
    get(p) {
      state.getCalls.push(p);
      // Return the conversation referenced in the path.
      const m = String(p).match(/conversations\/([^?]+)/);
      const convId = m ? decodeURIComponent(m[1]) : 'conv_unknown';
      return Promise.resolve({
        ok: true,
        data: {
          conversation_id: convId,
          employee_summary: { employee_id: 'emp_a', display_name: 'Alpha', role_name: '顾问' },
          messages: { items: [], next_cursor: 0, has_more: false },
          last_message_preview: { event_cursor: 0, preview: '' },
          latest_run: null,
        },
      });
    },
    getWorkbench() {
      state.workbenchCalls += 1;
      return Promise.resolve({ ok: true, data: { employees: [{ employee_id: 'emp_a', display_name: 'Alpha', role_name: '顾问', conversation_id: 'conv_old' }], groups: [] } });
    },
    getRunEvents() { return Promise.resolve({ ok: true, data: { items: [] } }); },
    updateWorkbenchState(body) { state.updateCalls.push(body); return Promise.resolve({ ok: true, data: {} }); },
    createRun(body) {
      state.createRunCalls.push(body);
      return Promise.resolve({ ok: true, data: { conversation_id: 'conv_new', run_id: 'run_new' } });
    },
  };
  context.global = context; context.globalThis = context;
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
  return { getCalls: [], updateCalls: [], pushCalls: [], replaceCalls: [], assignCalls: [], workbenchCalls: 0, createRunCalls: [] };
}

const tick = () => new Promise(function (r) { setTimeout(r, 0); });

test('draft → 发送首条消息后 URL 收敛到新会话(conv_new)', async function () {
  const state = newState();
  const { page, context } = freshPage(state);

  const container = makeNode();
  // 用户当前在旧会话 conv_old
  page.render(container, {
    conversation_id: 'conv_old',
    employee_summary: { employee_id: 'emp_a', display_name: 'Alpha', role_name: '顾问' },
    messages: { items: [], next_cursor: 0, has_more: false },
    last_message_preview: { event_cursor: 0, preview: '' },
    latest_run: null,
    __agentList: [{ employee_id: 'emp_a', display_name: 'Alpha', role_name: '顾问', conversation_id: 'conv_old' }],
  });

  // 点击"新建会话"进入草稿
  const newBtn = container.querySelector('[data-chat-new-conversation]');
  newBtn._handlers.click({ preventDefault() {} });
  await tick();
  assert.strictEqual(context.window.location.pathname, '/app/chat/emp_a', '草稿态 URL 应为员工草稿路由');

  // 在草稿里发送 "hi"
  const form = container.querySelector('[data-chat-form]');
  const input = container.querySelector('[data-chat-input]');
  input.value = 'hi';
  assert.ok(form._handlers.submit, 'form 应绑定 submit');
  form._handlers.submit({ preventDefault() {} });
  await tick();
  await tick();

  assert.strictEqual(state.createRunCalls.length, 1, '只应创建一次 run');
  assert.strictEqual(state.createRunCalls[0].create_new, true, '草稿态应携带 create_new=true');
  assert.strictEqual(context.window.location.pathname, '/app/chat/conv_new',
    '发送后 URL 应收敛到新会话 conv_new（刷新后才会停留在新会话）');
});
