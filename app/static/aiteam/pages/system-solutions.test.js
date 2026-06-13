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
  var createDrawer = appRoot.children[appRoot.children.length - 1];
  assert((createDrawer.innerHTML || '').indexOf('Test Corp') === -1, 'solution drawer opened before enterprise fetch should not yet have enterprise rows');
  resolveEnterprises({ ok: true, data: { enterprises: [{ enterprise_id: 'ent_test', name: 'Test Corp' }] } });
  await nextTick();
  await nextTick();
  createDrawer = appRoot.children[appRoot.children.length - 1];
  assert((createDrawer.innerHTML || '').indexOf('Test Corp') !== -1, 'solution drawer should refresh enterprise rows after async enterprise fetch resolves');
  assert((createDrawer.innerHTML || '').indexOf('data-picker-search') !== -1, 'solution drawer should expose the searchable enterprise picker after rows arrive');

  // Orchestration authoring lives in the system-backend create drawer (方案自带编排).
  const drawerEl = appRoot.children.find(function (c) { return (c.innerHTML || '').indexOf('创建行业方案') !== -1; });
  assert(!!drawerEl, 'create drawer should mount');
  assert(drawerEl && drawerEl.innerHTML.indexOf('协作编排规则') !== -1, 'create drawer should include the orchestration section');
  assert(drawerEl && drawerEl.innerHTML.indexOf('data-aiteam-sol-planner') !== -1, 'create drawer should include the planner orchestration field');
  assert(drawerEl && drawerEl.innerHTML.indexOf('data-aiteam-sol-subtask') !== -1, 'create drawer should include the subtask orchestration field');
  assert(drawerEl && drawerEl.innerHTML.indexOf('data-aiteam-sol-aggregate') !== -1, 'create drawer should include the aggregate orchestration field');
  // Detail pane surfaces whether a solution bundles orchestration.
  assert(host.innerHTML.indexOf('协作编排') !== -1, 'solution detail should surface orchestration status');

  // Option A refactor: redundant table dropped; cards(主) + 详情(含治理操作) master-detail.
  assert(host.innerHTML.indexOf('aiteam-table') === -1, 'redundant solutions table should be removed');
  assert(host.innerHTML.indexOf('aiteam-grid--split') !== -1, 'page should use a master-detail split layout');
  assert(host.innerHTML.indexOf('aiteam-card--selectable') !== -1, 'solution cards should be selectable master items');
  assert(host.innerHTML.indexOf('方案详情') !== -1, 'detail pane should render (default-selected first solution)');
  assert(host.innerHTML.indexOf('data-aiteam-action="update"') !== -1, 'governance actions should live in the detail pane');

  // 更新按钮 → 打开「编辑行业方案」抽屉（复用创建抽屉、全量回填，含专家选择器+编排）。
  // 专家绑定已并入抽屉的可搜索专家选择器，不再单独 window.prompt 绑定模板。
  // 抽屉内表单提交依赖真实 DOM，由 E2E 验证；此处验证点击挂载编辑抽屉。
  const updateHost = createHost();
  updateHost._buttons = [createActionButton('update', 'sol_retail')];
  page.init(updateHost);
  await nextTick();
  await nextTick();
  const editBefore = appRoot.children.length;
  updateHost._buttons[0].dispatchEvent({ type: 'click' });
  const editDrawer = appRoot.children.slice(editBefore).find(function (c) { return (c.innerHTML || '').indexOf('编辑行业方案') !== -1; });
  assert(!!editDrawer, 'clicking 编辑方案 should mount an edit drawer (reuses the create form)');
  assert(editDrawer && editDrawer.innerHTML.indexOf('配置专家') !== -1, 'edit drawer should include the expert picker');
  assert(editDrawer && editDrawer.innerHTML.indexOf('data-picker="sol-tpl"') !== -1, 'expert picker should be searchable');
  assert(editDrawer && editDrawer.innerHTML.indexOf('data-aiteam-sol-planner') !== -1, 'edit drawer should include orchestration fields');

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
