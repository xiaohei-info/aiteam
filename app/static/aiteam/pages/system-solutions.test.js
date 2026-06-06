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
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    style: {},
    attributes: {},
    events: {},
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      this.events[type] = this.events[type] || [];
      this.events[type].push(fn);
    },
    dispatchEvent(event) {
      const payload = event || { type: '' };
      if (!payload.currentTarget) payload.currentTarget = el;
      (this.events[payload.type] || []).forEach(function (fn) { fn.call(el, payload); });
    },
    setAttribute(key, value) {
      this.attributes[key] = String(value);
    },
    getAttribute(key) {
      return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
    },
  };
  el.classList = { add() {}, remove() {}, toggle() { return false; } };
  return el;
}

function createHost() {
  const host = createElement('div');
  host._createForm = createElement('form');
  host._nameInput = createElement('input');
  host._templatesInput = createElement('input');
  host._publishInput = createElement('input');
  host._publishInput.checked = false;
  host._buttons = [];
  host.querySelector = function (selector) {
    if (selector === '[data-aiteam-solution-create-form]') return this._createForm;
    if (selector === '[data-aiteam-solution-create-name]') return this._nameInput;
    if (selector === '[data-aiteam-solution-create-templates]') return this._templatesInput;
    if (selector === '[data-aiteam-solution-create-publish]') return this._publishInput;
    return null;
  };
  host.querySelectorAll = function (selector) {
    if (selector === 'button[data-aiteam-action][data-aiteam-solution-id]') return this._buttons;
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

const document = {
  body: createElement('body'),
  head: createElement('head'),
  createElement,
};

const apiCalls = [];
const promptQueue = [];
const context = {
  window: {
    aiteam: {
      api: {
        get(url) {
          apiCalls.push({ method: 'GET', url, body: null });
          return Promise.resolve({
            ok: true,
            data: { items: [{ solution_id: 'sol_retail', name: '零售方案', status: 'draft', template_ids: ['tpl_ops'] }] },
          });
        },
        post(url, body) {
          apiCalls.push({ method: 'POST', url, body });
          return Promise.resolve({ ok: true, data: { solution_id: 'sol_new', status: body.publish_action === 'publish' ? 'published' : 'draft' } });
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
  else {
    failed += 1;
    failures.push(message);
  }
}

async function nextTick() {
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
}

async function run() {
  assert(!!page, 'systemSolutions page should register');
  assert(typeof page.init === 'function', 'systemSolutions.init should exist');

  const createHostNode = createHost();
  page.init(createHostNode);
  await nextTick();
  assert(apiCalls[0] && apiCalls[0].url === '/api/system-admin/solutions', 'init should load solutions from system-admin route');
  assert(createHostNode.innerHTML.indexOf('新建方案') !== -1, 'page should render create form controls');
  createHostNode._nameInput.value = '零售新方案';
  createHostNode._templatesInput.value = 'tpl_ops, tpl_sales';
  createHostNode._publishInput.checked = true;
  createHostNode._createForm.dispatchEvent({ type: 'submit', preventDefault() {} });
  await nextTick();
  assert(JSON.stringify(apiCalls[1]) === JSON.stringify({
    method: 'POST',
    url: '/api/system-admin/solutions',
    body: { name: '零售新方案', template_ids: ['tpl_ops', 'tpl_sales'], publish_action: 'publish' },
  }), 'submitting rendered create form should POST to /api/system-admin/solutions');

  const updateHostNode = createHost();
  updateHostNode._buttons = [createActionButton('update', 'sol_retail')];
  page.init(updateHostNode);
  await nextTick();
  promptQueue.push('零售方案Pro', 'bundle-retail');
  updateHostNode._buttons[0].dispatchEvent({ type: 'click' });
  await nextTick();
  assert(JSON.stringify(apiCalls[3]) === JSON.stringify({
    method: 'PATCH',
    url: '/api/system-admin/solutions/sol_retail',
    body: { name: '零售方案Pro', default_skill_bundle: 'bundle-retail' },
  }), 'clicking rendered update button should PATCH the solution route');

  const bindHostNode = createHost();
  bindHostNode._buttons = [createActionButton('bind', 'sol_retail')];
  page.init(bindHostNode);
  await nextTick();
  promptQueue.push('tpl_ops, tpl_sales');
  bindHostNode._buttons[0].dispatchEvent({ type: 'click' });
  await nextTick();
  assert(JSON.stringify(apiCalls[5]) === JSON.stringify({
    method: 'PATCH',
    url: '/api/system-admin/solutions/sol_retail',
    body: { template_ids: ['tpl_ops', 'tpl_sales'] },
  }), 'clicking rendered bind button should PATCH template_ids on the solution route');

  const publishHostNode = createHost();
  publishHostNode._buttons = [createActionButton('publish', 'sol_retail')];
  page.init(publishHostNode);
  await nextTick();
  publishHostNode._buttons[0].dispatchEvent({ type: 'click' });
  await nextTick();
  assert(JSON.stringify(apiCalls[7]) === JSON.stringify({
    method: 'PATCH',
    url: '/api/system-admin/solutions/sol_retail',
    body: { publish_action: 'publish' },
  }), 'clicking rendered publish button should PATCH publish_action on the solution route');

  const unpublishHostNode = createHost();
  unpublishHostNode._buttons = [createActionButton('unpublish', 'sol_retail')];
  page.init(unpublishHostNode);
  await nextTick();
  unpublishHostNode._buttons[0].dispatchEvent({ type: 'click' });
  await nextTick();
  assert(JSON.stringify(apiCalls[9]) === JSON.stringify({
    method: 'PATCH',
    url: '/api/system-admin/solutions/sol_retail',
    body: { publish_action: 'unpublish' },
  }), 'clicking rendered unpublish button should PATCH unpublish on the solution route');

  if (failed) {
    console.error('system-solutions.test.js failed');
    failures.forEach(function (item) { console.error('- ' + item); });
    process.exit(1);
  }
  console.log('system-solutions.test.js passed:', passed, 'assertions');
}

run().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
