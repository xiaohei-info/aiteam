'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createElement(tag) {
  const el = {
    tagName: String(tag || '').toUpperCase(),
    children: [],
    parentNode: null,
    className: '',
    id: '',
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    hidden: false,
    disabled: false,
    style: {},
    attributes: {},
    events: {},
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) this.children.splice(idx, 1);
      return child;
    },
    focus() {},
    addEventListener(type, fn) { (this.events[type] = this.events[type] || []).push(fn); },
    dispatchEvent(event) {
      const payload = event || { type: '' };
      if (!payload.currentTarget) payload.currentTarget = this;
      (this.events[payload.type] || []).forEach((fn) => fn.call(this, payload));
    },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    getAttribute(key) {
      return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  el.classList = { add() {}, remove() {}, toggle() { return false; } };
  return el;
}

function createHost() {
  const host = createElement('div');
  host._openBtn = createElement('button');
  host._buttons = [];
  host.querySelector = function (selector) {
    if (selector === '[data-aiteam-solution-create-open]') return this._openBtn;
    return null;
  };
  host.querySelectorAll = function (selector) {
    if (selector === 'button[data-aiteam-action][data-aiteam-solution-id]') return this._buttons;
    if (selector === '[data-aiteam-solution-preview]') return [];
    return [];
  };
  return host;
}

function createActionButton(action, solutionId) {
  const button = createElement('button');
  button.setAttribute('data-aiteam-action', action);
  button.setAttribute('data-aiteam-solution-id', solutionId);
  return button;
}

const appRoot = createElement('div');
appRoot.id = 'aiteam-app';
const document = {
  body: createElement('body'),
  head: createElement('head'),
  createElement,
  getElementById(id) { return id === 'aiteam-app' ? appRoot : null; },
};

const apiCalls = [];
const promptQueue = [];
const context = {
  window: {
    aiteam: {
      api: {
        get(url) {
          apiCalls.push({ method: 'GET', url, body: null });
          if (url === '/api/system-admin/enterprises') {
            return Promise.resolve({ ok: true, data: { enterprises: [{ enterprise_id: 'ent_test', name: 'Test Corp' }] } });
          }
          if (url === '/api/system-admin/templates') {
            return Promise.resolve({ ok: true, data: { items: [{ template_id: 'tpl_ops', name: '运营专家', role_name: 'operator' }] } });
          }
          return Promise.resolve({
            ok: true,
            data: { items: [{ solution_id: 'sol_retail', name: '零售方案', status: 'draft', template_ids: ['tpl_ops'] }] },
          });
        },
        post(url, body) {
          apiCalls.push({ method: 'POST', url, body });
          return Promise.resolve({ ok: true, data: { solution_id: 'sol_new', status: 'draft' } });
        },
        patch(url, body) {
          apiCalls.push({ method: 'PATCH', url, body });
          return Promise.resolve({ ok: true, data: {} });
        },
      },
    },
    prompt(message, defaultValue) {
      if (!promptQueue.length) return defaultValue || '';
      return promptQueue.shift();
    },
  },
  document,
  console,
  setTimeout,
  clearTimeout,
};
context.global = context;
context.globalThis = context;
context.window.document = document;

const code = fs.readFileSync(path.join(__dirname, 'system-solutions.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const page = context.window.aiteam.pages && context.window.aiteam.pages.systemSolutions;
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) passed += 1;
  else { failed += 1; failures.push(message); }
}

async function nextTick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function lastCall(method, urlPart) {
  for (let i = apiCalls.length - 1; i >= 0; i -= 1) {
    if (apiCalls[i].method === method && apiCalls[i].url.indexOf(urlPart) !== -1) return apiCalls[i];
  }
  return null;
}

async function run() {
  assert(!!page, 'systemSolutions page should register');
  assert(typeof page.init === 'function', 'systemSolutions.init should exist');

  // 渲染 + 创建按钮触发抽屉（抽屉挂载到 aiteam-app）。
  const host = createHost();
  page.init(host);
  await nextTick();
  await nextTick();
  assert(!!lastCall('GET', '/api/system-admin/solutions'), 'init should load solutions');
  assert(host.innerHTML.indexOf('创建方案') !== -1, 'page should render 创建方案 button');
  const before = appRoot.children.length;
  host._openBtn.dispatchEvent({ type: 'click' });
  assert(appRoot.children.length > before, 'clicking 创建方案 should mount a drawer into aiteam-app');

  // Option A refactor: redundant table dropped; cards(主) + 详情(含治理操作) master-detail.
  assert(host.innerHTML.indexOf('aiteam-table') === -1, 'redundant solutions table should be removed');
  assert(host.innerHTML.indexOf('aiteam-grid--split') !== -1, 'page should use a master-detail split layout');
  assert(host.innerHTML.indexOf('aiteam-card--selectable') !== -1, 'solution cards should be selectable master items');
  assert(host.innerHTML.indexOf('方案详情') !== -1, 'detail pane should render (default-selected first solution)');
  assert(host.innerHTML.indexOf('data-aiteam-action="update"') !== -1, 'governance actions should live in the detail pane');

  // 更新按钮 → PATCH name + default_skill_bundle。
  const updateHost = createHost();
  updateHost._buttons = [createActionButton('update', 'sol_retail')];
  page.init(updateHost);
  await nextTick();
  await nextTick();
  promptQueue.push('零售方案Pro', 'bundle-retail');
  updateHost._buttons[0].dispatchEvent({ type: 'click' });
  await nextTick();
  const patchUpdate = lastCall('PATCH', '/api/system-admin/solutions/sol_retail');
  assert(patchUpdate && patchUpdate.body.name === '零售方案Pro' && patchUpdate.body.default_skill_bundle === 'bundle-retail',
    'update button should PATCH name + default_skill_bundle');

  // 绑定按钮 → PATCH template_ids。
  const bindHost = createHost();
  bindHost._buttons = [createActionButton('bind', 'sol_retail')];
  page.init(bindHost);
  await nextTick();
  await nextTick();
  promptQueue.push('tpl_ops, tpl_sales');
  bindHost._buttons[0].dispatchEvent({ type: 'click' });
  await nextTick();
  const patchBind = lastCall('PATCH', '/api/system-admin/solutions/sol_retail');
  assert(patchBind && JSON.stringify(patchBind.body.template_ids) === JSON.stringify(['tpl_ops', 'tpl_sales']),
    'bind button should PATCH template_ids');

  // 发布按钮 → PATCH publish_action。
  const publishHost = createHost();
  publishHost._buttons = [createActionButton('publish', 'sol_retail')];
  page.init(publishHost);
  await nextTick();
  await nextTick();
  publishHost._buttons[0].dispatchEvent({ type: 'click' });
  await nextTick();
  const patchPublish = lastCall('PATCH', '/api/system-admin/solutions/sol_retail');
  assert(patchPublish && patchPublish.body.publish_action === 'publish',
    'publish button should PATCH publish_action=publish');

  if (failed) {
    console.error('system-solutions.test.js failed');
    failures.forEach((item) => console.error('- ' + item));
    process.exit(1);
  }
  console.log('system-solutions.test.js passed:', passed, 'assertions');
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
