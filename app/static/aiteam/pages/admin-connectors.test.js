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
    value: '',
    checked: false,
    disabled: false,
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
let getEmployeesCalls = 0;
let detailCalls = 0;
let updateCalls = 0;
let testCalls = 0;
let statusCalls = 0;
let createPayload = null;
let updatePayload = null;
let latestGrantPayload = null;
const connectorSnapshots = [
  {
    items: [{
      connector_id: 'conn_truth',
      definition_id: 'def_slack_webhook',
      name: 'Slack Connector',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      status: 'online',
      scopes: ['invoke'],
      credential_ref: 'cred://vault/slack/ent_test',
      credential_mask: '已配置',
      credential_state: 'configured',
      rotation_version: 2,
      config: { tenant_hint: 'acme', channel: '#seed', bot_secret: 'hidden' },
      employee_grants: [{
        binding_id: 'bind_seed',
        employee_id: 'emp_seed',
        employee_display_name: '种子员工',
        access_mode: 'invoke',
        enabled: true,
      }],
      granted_employee_ids: ['emp_seed'],
      last_test_result: {
        result: 'passed',
        checked_at: '2026-06-05T00:00:00Z',
        checked_by: 'user_seed',
        error_code: '',
        message: '最近一次连接测试通过',
        log_ref: 'audit://connector-test/seed',
      },
      updated_at: '2026-06-05T00:00:00Z',
      updated_by: 'user_seed',
      created_at: '2026-06-04T00:00:00Z',
    }],
    definitions: [{
      definition_id: 'def_slack_webhook',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      display_name: 'Slack Webhook',
      auth_scheme: 'opaque_ref',
      status: 'active',
    }],
  },
  {
    items: [{
      connector_id: 'conn_truth',
      definition_id: 'def_slack_webhook',
      name: 'Slack Connector',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      status: 'draft',
      scopes: ['invoke'],
      credential_ref: 'cred://vault/slack/updated',
      credential_mask: '已轮换',
      credential_state: 'rotated',
      rotation_version: 3,
      config: { tenant_hint: 'acme-updated', channel: '#ops', bot_secret: 'hidden' },
      employee_grants: [{
        binding_id: 'bind_seed',
        employee_id: 'emp_seed',
        employee_display_name: '种子员工',
        access_mode: 'invoke',
        enabled: true,
      }],
      granted_employee_ids: ['emp_seed'],
      last_test_result: {
        result: 'never_tested',
        checked_at: '',
        checked_by: '',
        error_code: '',
        message: '等待复测',
        log_ref: '',
      },
      updated_at: '2026-06-06T12:00:00Z',
      updated_by: 'user_editor',
      created_at: '2026-06-04T00:00:00Z',
    }],
    definitions: [{
      definition_id: 'def_slack_webhook',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      display_name: 'Slack Webhook',
      auth_scheme: 'opaque_ref',
      status: 'active',
    }],
  },
  {
    items: [{
      connector_id: 'conn_truth',
      definition_id: 'def_slack_webhook',
      name: 'Slack Connector',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      status: 'online',
      scopes: ['invoke'],
      credential_ref: 'cred://vault/slack/updated',
      credential_mask: '已轮换',
      credential_state: 'rotated',
      rotation_version: 3,
      config: { tenant_hint: 'acme-updated', channel: '#ops', bot_secret: 'hidden' },
      employee_grants: [{
        binding_id: 'bind_backend',
        employee_id: 'emp_backend',
        employee_display_name: '后端同步员工',
        access_mode: 'invoke',
        enabled: true,
      }],
      granted_employee_ids: ['emp_backend'],
      last_test_result: {
        result: 'passed',
        checked_at: '2026-06-06T00:00:00Z',
        checked_by: 'user_test',
        error_code: '',
        message: 'rechecked from backend',
        log_ref: 'audit://connector-test/recheck',
      },
      updated_at: '2026-06-06T12:00:00Z',
      updated_by: 'user_test',
      created_at: '2026-06-04T00:00:00Z',
    }],
    definitions: [{
      definition_id: 'def_slack_webhook',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      display_name: 'Slack Webhook',
      auth_scheme: 'opaque_ref',
      status: 'active',
    }],
  },
  {
    items: [{
      connector_id: 'conn_truth',
      definition_id: 'def_slack_webhook',
      name: 'Slack Connector',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      status: 'online',
      scopes: ['invoke'],
      credential_ref: 'cred://vault/slack/updated',
      credential_mask: '已轮换',
      credential_state: 'rotated',
      rotation_version: 3,
      config: { tenant_hint: 'acme-updated', channel: '#ops', bot_secret: 'hidden' },
      employee_grants: [{
        binding_id: 'bind_backend',
        employee_id: 'emp_backend',
        employee_display_name: '后端同步员工',
        access_mode: 'invoke',
        enabled: true,
      }],
      granted_employee_ids: ['emp_backend'],
      last_test_result: {
        result: 'passed',
        checked_at: '2026-06-06T00:00:00Z',
        checked_by: 'user_test',
        error_code: '',
        message: 'rechecked from backend',
        log_ref: 'audit://connector-test/recheck',
      },
      updated_at: '2026-06-06T12:00:00Z',
      updated_by: 'user_test',
      created_at: '2026-06-04T00:00:00Z',
    }],
    definitions: [{
      definition_id: 'def_slack_webhook',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      display_name: 'Slack Webhook',
      auth_scheme: 'opaque_ref',
      status: 'active',
    }],
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
        getEmployees() {
          getEmployeesCalls += 1;
          return Promise.resolve({ ok: true, data: { employees: [
            { employee_id: 'emp_seed', display_name: '种子员工', status: 'active' },
            { employee_id: 'emp_backend', display_name: '后端同步员工', status: 'active' },
            { employee_id: 'emp_extra', display_name: '扩展员工', status: 'paused' },
          ] } });
        },
        createConnector(payload) {
          createPayload = payload;
          return Promise.resolve({ ok: true, data: { connector_id: 'conn_new', status: 'draft', credential_state: 'configured' } });
        },
        getConnector(connectorId) {
          detailCalls += 1;
          const index = detailCalls === 1 ? 0 : Math.min(detailCalls - 1, connectorSnapshots.length - 1);
          return Promise.resolve({ ok: true, data: connectorSnapshots[index].items[0] });
        },
        updateConnector(connectorId, payload) {
          updateCalls += 1;
          updatePayload = { connectorId, payload };
          return Promise.resolve({ ok: true, data: { connector_id: connectorId, status: 'draft', credential_state: 'rotated' } });
        },
        updateConnectorGrants(connectorId, payload) {
          updateCalls += 1;
          latestGrantPayload = { connectorId, payload };
          return Promise.resolve({ ok: true, data: { connector_id: connectorId, accepted: payload } });
        },
        testConnector(connectorId) {
          testCalls += 1;
          return Promise.resolve({ ok: true, data: { connector_id: connectorId, result: 'passed', status: 'online' } });
        },
        getConnectorStatus(connectorId) {
          statusCalls += 1;
          return Promise.resolve({ ok: true, data: {
            connector_id: connectorId,
            status: 'online',
            credential_state: 'rotated',
            updated_at: '2026-06-07T00:00:00Z',
            last_test_result: {
              result: 'passed',
              checked_at: '2026-06-07T00:00:00Z',
              checked_by: 'user_status',
              error_code: '',
              message: 'status poll refreshed',
              log_ref: 'audit://connector-status/1',
            },
          } });
        },
      },
      role: {
        getActiveRole() { return 'owner'; },
      },
      states: {
        renderLoading(host) {
          host.innerHTML = '<div>loading</div>';
        },
        renderPermissionDenied(host) {
          host.innerHTML = '<div>denied</div>';
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
  await nextTick();

  assert(getConnectorsCalls === 1, 'init should fetch connector list once');
  assert(getEmployeesCalls === 1, 'init should fetch employee list once');
  assert(detailCalls === 1, 'init should fetch connector detail once');
  assert(host.innerHTML.indexOf('凭据状态') !== -1, 'page should render masked credential state block');
  assert(host.innerHTML.indexOf('凭据显示') !== -1, 'page should render masked credential block');
  assert(host.innerHTML.indexOf('cred://vault/slack/ent_test') !== -1, 'page should render opaque credential ref');
  assert(host.innerHTML.indexOf('bot_secret: hidden') === -1, 'page should not expose raw secret config');
  assert(host.innerHTML.indexOf('bot_secret: ****') !== -1, 'page should mask secret config values');
  assert(host.innerHTML.indexOf('最近一次连接测试通过') !== -1, 'page should render backend last_test_result summary');
  assert(host.innerHTML.indexOf('种子员工') !== -1, 'page should render employee display names in grant summary');
  assert(host.innerHTML.indexOf('Slack Webhook') !== -1, 'page should render connector definition options');
  assert(host.innerHTML.indexOf('受控输入') !== -1, 'page should present controlled credential input copy');
  assert(host.innerHTML.indexOf('保存详情') !== -1, 'page should render detail update action');
  assert(host.innerHTML.indexOf('prompt') === -1, 'page html should not mention legacy prompt flow');

  await host.lastUpdateHandler('conn_truth', {
    name: 'Slack Connector',
    config: { tenant_hint: 'acme-updated', channel: '#ops' },
    credential_input: { mode: 'opaque_ref', credential_ref: 'cred://vault/slack/updated' },
    credential_ref: 'cred://vault/slack/updated',
  });
  await nextTick();
  assert(updateCalls === 1, 'detail handler should call updateConnector');
  assert(updatePayload && updatePayload.payload.credential_input.credential_ref === 'cred://vault/slack/updated', 'update payload should submit rotated opaque ref');
  assert(host.innerHTML.indexOf('已轮换') !== -1, 'detail update should render refreshed credential mask');
  assert(host.innerHTML.indexOf('draft') === -1, 'detail update should render localized status instead of raw enum');
  assert(host.innerHTML.indexOf('草稿') !== -1, 'detail update should render updated draft status');
  assert(host.innerHTML.indexOf('#ops') !== -1, 'detail update should render refreshed config summary from detail fetch');
  assert(host.innerHTML.indexOf('等待复测') !== -1, 'detail update should render refreshed last_test_result from detail fetch');

  await host.lastCreateHandler({
    definition_id: 'def_slack_webhook',
    name: '公司 Slack',
    provider_code: 'slack',
    connector_type: 'webhook_target',
    config: { tenant_hint: 'acme', channel: '#sales' },
    credential_input: { mode: 'opaque_ref', credential_ref: 'cred://enterprise/new' },
    credential_ref: 'cred://enterprise/new',
  });
  await nextTick();
  assert(!!createPayload, 'create handler should call createConnector');
  assert(createPayload.credential_input && createPayload.credential_input.credential_ref === 'cred://enterprise/new', 'create payload should submit credential_input opaque ref');
  assert(getConnectorsCalls === 3, 'create success should re-fetch connector list');

  await host.lastGrantHandler('conn_truth', {
    grant: [{ employee_ids: ['emp_backend', 'emp_extra'], access_mode: 'invoke' }],
    revoke: [{ binding_id: 'bind_seed' }],
  });
  await nextTick();
  assert(updateCalls === 2, 'grant handler should call connector update/grant API once after detail update');
  assert(latestGrantPayload && latestGrantPayload.payload.revoke[0].binding_id === 'bind_seed', 'grant payload should carry revoke binding ids');
  assert(getConnectorsCalls === 4, 'grant success should re-fetch connector list');
  assert(host.innerHTML.indexOf('后端同步员工') !== -1, 'grant success should render backend-refreshed grants');
  assert(host.innerHTML.indexOf('种子员工</span><span class="aiteam-shell__meta-value">emp_seed · 仅调用') === -1, 'grant success should not leave stale granted employee summary in UI');

  await host.lastTestHandler('conn_truth', { mode: 'manual', dry_run: false });
  await nextTick();
  assert(testCalls === 1, 'test handler should call testConnector');
  assert(getConnectorsCalls === 5, 'test success should re-fetch connector list');
  assert(host.innerHTML.indexOf('rechecked from backend') !== -1, 'test success should render backend-refreshed test message');
  assert(host.innerHTML.indexOf('2026-06-06T00:00:00Z') !== -1, 'test success should render backend-refreshed checked_at');

  await host.lastStatusHandler('conn_truth');
  await nextTick();
  assert(statusCalls === 1, 'status refresh should call getConnectorStatus when available');
  assert(host.innerHTML.indexOf('已轮换待复测') !== -1, 'status refresh should update credential_state from status endpoint');
  assert(host.innerHTML.indexOf('status poll refreshed') !== -1, 'status refresh should update last_test_result summary');

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
