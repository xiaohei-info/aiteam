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
  host._roleInput = createElement('input');
  host._publishInput = createElement('input');
  host._publishInput.checked = false;
  host._buttons = [];
  host.querySelector = function (selector) {
    if (selector === '[data-aiteam-template-create-form]') return this._createForm;
    if (selector === '[data-aiteam-template-create-name]') return this._nameInput;
    if (selector === '[data-aiteam-template-create-role]') return this._roleInput;
    if (selector === '[data-aiteam-template-create-publish]') return this._publishInput;
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
            data: { items: [{ template_id: 'tpl_ops', name: '运营专家', role_name: 'operator', status: 'draft' }] },
          });
        },
        post(url, body) {
          apiCalls.push({ method: 'POST', url, body });
          return Promise.resolve({ ok: true, data: { template_id: 'tpl_new', status: body.publish_action === 'publish' ? 'published' : 'draft' } });
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

const code = fs.readFileSync(path.join(__dirname, 'system-templates.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const page = context.window.aiteam.pages && context.window.aiteam.pages.systemTemplates;
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
  assert(!!page, 'systemTemplates page should register');
  assert(typeof page.init === 'function', 'systemTemplates.init should exist');

  const createHostNode = createHost();
  page.init(createHostNode);
  await nextTick();
  assert(apiCalls[0] && apiCalls[0].url === '/api/system-admin/templates', 'init should load templates from system-admin route');
  assert(createHostNode.innerHTML.indexOf('新建模板') !== -1, 'page should render create form controls');
  createHostNode._nameInput.value = '新模板';
  createHostNode._roleInput.value = 'assistant';
  createHostNode._publishInput.checked = true;
  createHostNode._createForm.dispatchEvent({ type: 'submit', preventDefault() {} });
  await nextTick();
  assert(JSON.stringify(apiCalls[1]) === JSON.stringify({
    method: 'POST',
    url: '/api/system-admin/templates',
    body: { name: '新模板', role_name: 'assistant', publish_action: 'publish' },
  }), 'submitting rendered create form should POST to /api/system-admin/templates');

  const updateHostNode = createHost();
  updateHostNode._buttons = [createActionButton('update', 'tpl_ops')];
  page.init(updateHostNode);
  await nextTick();
  promptQueue.push('运营专家Pro', 'senior-operator');
  updateHostNode._buttons[0].dispatchEvent({ type: 'click' });
  await nextTick();
  assert(JSON.stringify(apiCalls[3]) === JSON.stringify({
    method: 'PATCH',
    url: '/api/system-admin/templates/tpl_ops',
    body: { name: '运营专家Pro', role_name: 'senior-operator' },
  }), 'clicking rendered update button should PATCH the template route');

  const publishHostNode = createHost();
  publishHostNode._buttons = [createActionButton('publish', 'tpl_ops')];
  page.init(publishHostNode);
  await nextTick();
  publishHostNode._buttons[0].dispatchEvent({ type: 'click' });
  await nextTick();
  assert(JSON.stringify(apiCalls[5]) === JSON.stringify({
    method: 'PATCH',
    url: '/api/system-admin/templates/tpl_ops',
    body: { publish_action: 'publish' },
  }), 'clicking rendered publish button should PATCH publish_action to the template route');

  const unpublishHostNode = createHost();
  unpublishHostNode._buttons = [createActionButton('unpublish', 'tpl_ops')];
  page.init(unpublishHostNode);
  await nextTick();
  unpublishHostNode._buttons[0].dispatchEvent({ type: 'click' });
  await nextTick();
  assert(JSON.stringify(apiCalls[7]) === JSON.stringify({
    method: 'PATCH',
    url: '/api/system-admin/templates/tpl_ops',
    body: { publish_action: 'unpublish' },
  }), 'clicking rendered unpublish button should PATCH unpublish to the template route');

  if (failed) {
    console.error('system-templates.test.js failed');
    failures.forEach(function (item) { console.error('- ' + item); });
    process.exit(1);
  }
  console.log('system-templates.test.js passed:', passed, 'assertions');
}

run().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
