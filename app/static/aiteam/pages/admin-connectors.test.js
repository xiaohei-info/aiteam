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
      (this.events[payload.type] || []).forEach(function (fn) { fn.call(el, payload); });
    },
    setAttribute(key, value) {
      this.attributes[key] = String(value);
    },
    getAttribute(key) {
      return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  el.classList = { add() {}, remove() {}, toggle() { return false; } };
  return el;
}

const document = {
  body: createElement('body'),
  head: createElement('head'),
  createElement,
};

let getConnectorsCalls = 0;
let updateGrantCalls = 0;
let testCalls = 0;
const connectorSnapshots = [
  {
    connectors: [{
      connector_id: 'conn_truth',
      name: 'Slack Connector',
      provider_code: 'slack',
      connector_type: 'oauth_connector',
      status: 'online',
      health_status: 'online',
      credential_ref: 'cred://vault/slack/ent_test',
      config: { tenant_hint: 'acme', bot_secret: 'hidden' },
      grants: ['emp_seed'],
      employee_grants: [{ employee_id: 'emp_seed', access_mode: 'invoke', enabled: true }],
      granted_employee_ids: ['emp_seed'],
      last_test_at: '2026-06-05T00:00:00Z',
      created_at: '2026-06-04T00:00:00Z',
    }],
    definitions: [],
  },
  {
    connectors: [{
      connector_id: 'conn_truth',
      name: 'Slack Connector',
      provider_code: 'slack',
      connector_type: 'oauth_connector',
      status: 'online',
      health_status: 'online',
      credential_ref: 'cred://vault/slack/ent_test',
      config: { tenant_hint: 'acme', bot_secret: 'hidden' },
      grants: ['emp_backend'],
      employee_grants: [{ employee_id: 'emp_backend', access_mode: 'invoke', enabled: true }],
      granted_employee_ids: ['emp_backend'],
      last_test_at: '2026-06-05T00:00:00Z',
      created_at: '2026-06-04T00:00:00Z',
    }],
    definitions: [],
  },
  {
    connectors: [{
      connector_id: 'conn_truth',
      name: 'Slack Connector',
      provider_code: 'slack',
      connector_type: 'oauth_connector',
      status: 'online',
      health_status: 'online',
      credential_ref: 'cred://vault/slack/ent_test',
      config: { tenant_hint: 'acme', bot_secret: 'hidden' },
      grants: ['emp_backend'],
      employee_grants: [{ employee_id: 'emp_backend', access_mode: 'invoke', enabled: true }],
      granted_employee_ids: ['emp_backend'],
      last_test_at: '2026-06-06T00:00:00Z',
      test_log: 'rechecked from backend',
      created_at: '2026-06-04T00:00:00Z',
    }],
    definitions: [],
  },
];

const context = {
  window: {
    aiteam: {
      api: {
        getConnectors() {
          const index = Math.min(getConnectorsCalls, connectorSnapshots.length - 1);
          getConnectorsCalls += 1;
          return Promise.resolve({ ok: true, data: connectorSnapshots[index] });
        },
        updateConnectorGrants(connectorId, payload) {
          updateGrantCalls += 1;
          return Promise.resolve({ ok: true, data: { connector_id: connectorId, accepted: payload } });
        },
        testConnector(connectorId) {
          testCalls += 1;
          return Promise.resolve({ ok: true, data: { connector_id: connectorId, status: 'online' } });
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

const code = fs.readFileSync(path.join(__dirname, 'admin-connectors.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const page = context.window.aiteam.pages && context.window.aiteam.pages.adminConnectors;
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
  assert(!!page, 'adminConnectors page should register');
  assert(typeof page.init === 'function', 'adminConnectors.init should exist');

  const host = createElement('div');
  page.init(host);
  await nextTick();

  assert(getConnectorsCalls === 1, 'init should fetch connector list once');
  assert(host.innerHTML.indexOf('tenant_hint: acme') !== -1, 'page should render truthful backend config summary');
  assert(host.innerHTML.indexOf('emp_seed') !== -1, 'page should render truthful backend grants from list payload');
  assert(host.innerHTML.indexOf('最近检测：2026-06-05T00:00:00Z') !== -1, 'page should render truthful backend last_test_at');
  assert(host.innerHTML.indexOf('****') !== -1, 'page should mask credential reference in UI');

  await host.lastGrantHandler('conn_truth', { employee_ids: ['emp_local'] });
  await nextTick();
  assert(updateGrantCalls === 1, 'grant handler should call updateConnectorGrants');
  assert(getConnectorsCalls === 2, 'grant success should re-fetch connector list');
  assert(host.innerHTML.indexOf('emp_backend') !== -1, 'grant success should render backend-refreshed grants');
  assert(host.innerHTML.indexOf('emp_local') === -1, 'grant success should not leave speculative local grant state in UI');

  await host.lastTestHandler('conn_truth', {});
  await nextTick();
  assert(testCalls === 1, 'test handler should call testConnector');
  assert(getConnectorsCalls === 3, 'test success should re-fetch connector list');
  assert(host.innerHTML.indexOf('最近检测：2026-06-06T00:00:00Z') !== -1, 'test success should render backend-refreshed last_test_at');
  assert(host.innerHTML.indexOf('rechecked from backend') !== -1, 'test success should render backend-refreshed test log');

  if (failed) {
    console.error('admin-connectors.test.js failed');
    failures.forEach(function (item) { console.error('- ' + item); });
    process.exit(1);
  }
  console.log('admin-connectors.test.js passed:', passed, 'assertions');
}

run().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
