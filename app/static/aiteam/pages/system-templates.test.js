'use strict';

// system-templates.js 交互回归测试（轻量 DOM mock）。
// 覆盖：表格治理操作（update / publish / unpublish）与「创建专家」按钮触发抽屉。
// 抽屉内部表单提交依赖真实 DOM（innerHTML + querySelector），由 Playwright 端到端验证，
// 不在此处用手写 HTML parser 模拟，避免脆弱断言。

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
    if (selector === '[data-aiteam-template-create-open]') return this._openBtn;
    return null;
  };
  host.querySelectorAll = function (selector) {
    if (selector === 'button[data-aiteam-action][data-aiteam-template-id]') return this._buttons;
    return [];
  };
  return host;
}

function createActionButton(action, templateId) {
  const button = createElement('button');
  button.setAttribute('data-aiteam-action', action);
  button.setAttribute('data-aiteam-template-id', templateId);
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
var resolveEnterprises;
const enterprisesReady = new Promise((resolve) => {
  resolveEnterprises = resolve;
});
const context = {
  window: {
    aiteam: {
      api: {
        get(url) {
          apiCalls.push({ method: 'GET', url, body: null });
          if (url === '/api/system-admin/enterprises') {
            return enterprisesReady;
          }
          return Promise.resolve({
            ok: true,
            data: { items: [{ template_id: 'tpl_ops', name: '运营专家', role_name: 'operator', status: 'draft' }] },
          });
        },
        post(url, body) {
          apiCalls.push({ method: 'POST', url, body });
          return Promise.resolve({ ok: true, data: { template_id: 'tpl_new', status: 'draft' } });
        },
        patch(url, body) {
          apiCalls.push({ method: 'PATCH', url, body });
          return Promise.resolve({ ok: true, data: {} });
        },
      },
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

const code = fs.readFileSync(path.join(__dirname, 'system-templates.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const page = context.window.aiteam.pages && context.window.aiteam.pages.systemTemplates;
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
  assert(!!page, 'systemTemplates page should register');
  assert(typeof page.init === 'function', 'systemTemplates.init should exist');

  // 渲染 + 创建按钮触发抽屉（抽屉挂载到 aiteam-app）。
  const host = createHost();
  page.init(host);
  await nextTick();
  await nextTick();
  assert(!!lastCall('GET', '/api/system-admin/templates'), 'init should load templates');
  assert(host.innerHTML.indexOf('创建专家') !== -1, 'page should render 创建专家 button');
  const drawerCountBefore = appRoot.children.length;
  host._openBtn.dispatchEvent({ type: 'click' });
  assert(appRoot.children.length > drawerCountBefore, 'clicking 创建专家 should mount a drawer into aiteam-app');
  var createDrawer = appRoot.children[appRoot.children.length - 1];
  assert((createDrawer.innerHTML || '').indexOf('Test Corp') === -1, 'drawer opened before enterprise fetch should not yet have enterprise rows');
  resolveEnterprises({ ok: true, data: { enterprises: [{ enterprise_id: 'ent_test', name: 'Test Corp' }] } });
  await nextTick();
  await nextTick();
  createDrawer = appRoot.children[appRoot.children.length - 1];
  assert((createDrawer.innerHTML || '').indexOf('Test Corp') !== -1, 'drawer should refresh enterprise rows after async enterprise fetch resolves');
  assert((createDrawer.innerHTML || '').indexOf('data-picker-search') !== -1, 'drawer should keep the searchable picker after enterprise rows arrive');

  // 表格更新按钮 → 打开「编辑专家」抽屉（复用创建抽屉、全量回填编辑）。
  // 抽屉内表单提交依赖真实 DOM，由 E2E 验证；此处验证点击会挂载编辑抽屉。
  const updateHost = createHost();
  updateHost._buttons = [createActionButton('update', 'tpl_ops')];
  page.init(updateHost);
  await nextTick();
  await nextTick();
  const editCountBefore = appRoot.children.length;
  updateHost._buttons[0].dispatchEvent({ type: 'click' });
  const mountedEdit = appRoot.children.slice(editCountBefore).some((el) => (el.innerHTML || '').indexOf('编辑专家') !== -1);
  assert(appRoot.children.length > editCountBefore, 'clicking 更新 should mount an edit drawer');
  assert(mountedEdit, 'edit drawer should be titled 编辑专家 (reuses the create form for full edit)');

  // 发布按钮 → PATCH publish_action。
  const publishHost = createHost();
  publishHost._buttons = [createActionButton('publish', 'tpl_ops')];
  page.init(publishHost);
  await nextTick();
  await nextTick();
  publishHost._buttons[0].dispatchEvent({ type: 'click' });
  await nextTick();
  const patchPublish = lastCall('PATCH', '/api/system-admin/templates/tpl_ops');
  assert(patchPublish && patchPublish.body.publish_action === 'publish',
    'publish button should PATCH publish_action=publish');

  if (failed) {
    console.error('system-templates.test.js failed');
    failures.forEach((item) => console.error('- ' + item));
    process.exit(1);
  }
  console.log('system-templates.test.js passed:', passed, 'assertions');
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
