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
      (this.events[event.type] || []).forEach(function (fn) { fn.call(el, event); });
    },
    setAttribute(key, value) {
      this.attributes[key] = String(value);
    },
    getAttribute(key) {
      return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
    },
    querySelectorAll(selector) {
      if (selector === '.aiteam-employee-row') return this._rows || [];
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

let pushedPath = null;
let replacedPath = null;

let drawerOpened = null;
let getEmployeesCalls = 0;
const context = {
  window: {
    aiteam: {
      api: {
        getEmployees() {
          getEmployeesCalls += 1;
          return Promise.resolve({ ok: true, data: { employees: [
            { employee_id: 'emp_1', display_name: 'Alice', role_name: '分析师', status: 'active' },
          ] } });
        },
      },
      pages: {
        adminEmployeeDrawer: {
          init() {},
          open(employeeId, options) {
            drawerOpened = { employeeId, options: options || {} };
          },
        },
      },
      states: {
        handleApiResult(result, container) {
          container.innerHTML = 'error:' + (result && result.status);
        },
        renderEmpty(container, message) {
          container.innerHTML = message || 'empty';
        },
      },
    },
    location: { pathname: '/admin/employees' },
    history: {
      pushState(_state, _title, path) {
        pushedPath = path;
      },
      replaceState(_state, _title, path) {
        replacedPath = path;
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

const code = fs.readFileSync(path.join(__dirname, 'admin-employees.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const page = context.window.aiteam.pages && context.window.aiteam.pages.adminEmployees;
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

async function run() {
  assert(!!page, 'adminEmployees page should register');
  assert(typeof page.init === 'function', 'adminEmployees.init should exist');

  const host = createElement('div');
  host._rows = [createElement('tr')];
  host._rows[0].setAttribute('data-employee-id', 'emp_1');
  page.init(host);
  await new Promise(function (resolve) { setTimeout(resolve, 0); });

  assert(getEmployeesCalls === 1, 'page should use ns.api.getEmployees');
  assert(host.innerHTML.indexOf('管理企业的全部数字员工') !== -1, 'page should render production employee copy');
  assert(host.innerHTML.indexOf('/api/team/employees') === -1, 'page should not expose API paths in user copy');
  assert(host.innerHTML.indexOf('新建员工') !== -1, 'page should render the create-employee button');
  assert(host.innerHTML.indexOf('data-role="create-employee-form"') !== -1, 'page should render the create-employee form');
  assert(host.innerHTML.indexOf('data-role="create-employee-modal"') !== -1, 'create-employee form should live in a modal overlay');
  assert(host.innerHTML.indexOf('data-role="create-employee-model"') !== -1, 'create dialog should render a model selector at creation time');
  assert(host.innerHTML.indexOf('name="system_prompt"') !== -1, 'create dialog should render a system prompt field at creation time');
  assert(host.innerHTML.indexOf('data-role="delete-employee"') !== -1, 'each row should render a delete button');
  assert(host.innerHTML.indexOf('<th>操作</th>') !== -1, 'table should include an actions column');
  host._rows[0].dispatchEvent({ type: 'click' });
  assert(pushedPath === '/admin/employees/emp_1', 'clicking an employee row should push nested employee detail route');
  assert(drawerOpened && drawerOpened.employeeId === 'emp_1', 'clicking an employee row should open drawer');

  context.window.location.pathname = '/admin/employees/emp_2/loop';
  drawerOpened = null;
  page.init(host);
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  assert(drawerOpened && drawerOpened.employeeId === 'emp_2', 'nested employee detail route should auto-open drawer');
  assert(drawerOpened && drawerOpened.options && drawerOpened.options.tab === 'loop', 'nested employee detail route should pass requested tab to drawer');

  if (failed) {
    console.error('admin-employees.test.js failed');
    failures.forEach(function (item) { console.error('- ' + item); });
    process.exit(1);
  }
  console.log('admin-employees.test.js passed:', passed, 'assertions');
}

run().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
