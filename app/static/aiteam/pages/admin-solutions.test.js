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

let getSolutionsCalls = 0;
let applyCalls = 0;
const applyPayloads = [];
const solutionSnapshots = [
  {
    solutions: [{
      solution_id: 'sol_truth',
      name: '零售增长方案',
      status: 'published',
      tags: ['retail'],
      template_ids: ['tpl_ops'],
      template_count: 1,
      apply_count: 1,
      active_employee_count: 1,
      publish_record: { created_at: '2026-06-04T00:00:00Z' },
      last_apply_record_id: 'apply_001',
      last_apply_status: 'succeeded',
      created_employee_ids: ['emp_seed'],
      created_knowledge_base_ids: ['kb_seed'],
      solution_stats: { apply_count: 1, active_employee_count: 1, template_count: 1 },
    }],
  },
  {
    solutions: [{
      solution_id: 'sol_truth',
      name: '零售增长方案',
      status: 'published',
      tags: ['retail'],
      template_ids: ['tpl_ops'],
      template_count: 1,
      apply_count: 4,
      active_employee_count: 3,
      publish_record: { created_at: '2026-06-04T00:00:00Z' },
      last_apply_record_id: 'apply_002',
      last_apply_status: 'succeeded',
      created_employee_ids: ['emp_backend'],
      created_knowledge_base_ids: ['kb_backend'],
      solution_stats: { apply_count: 4, active_employee_count: 3, template_count: 1 },
    }],
  },
];

const context = {
  window: {
    aiteam: {
      api: {
        getSolutions() {
          const index = Math.min(getSolutionsCalls, solutionSnapshots.length - 1);
          getSolutionsCalls += 1;
          return Promise.resolve({ ok: true, data: solutionSnapshots[index] });
        },
        applySolution(solutionId, payload) {
          applyCalls += 1;
          applyPayloads.push({ solutionId, payload });
          return Promise.resolve({
            ok: true,
            data: {
              solution_id: solutionId,
              status: 'succeeded',
              apply_record_id: 'apply_local',
              created_employee_ids: ['emp_local'],
              created_knowledge_base_ids: ['kb_local'],
              accepted_payload: payload,
            },
          });
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

const code = fs.readFileSync(path.join(__dirname, 'admin-solutions.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const page = context.window.aiteam.pages && context.window.aiteam.pages.adminSolutions;
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
  assert(!!page, 'adminSolutions page should register');
  assert(typeof page.init === 'function', 'adminSolutions.init should exist');

  const host = createElement('div');
  page.init(host);
  await nextTick();

  assert(getSolutionsCalls === 1, 'init should fetch solution list once');
  assert(host.innerHTML.indexOf('最近应用状态') !== -1, 'page should render truthful backend apply state section');
  assert(host.innerHTML.indexOf('apply_001') !== -1, 'page should render truthful backend last_apply_record_id');
  assert(host.innerHTML.indexOf('emp_seed') !== -1, 'page should render truthful backend created_employee_ids');
  assert(host.innerHTML.indexOf('追加应用') !== -1, 'page should render append action');
  assert(host.innerHTML.indexOf('覆盖重建') !== -1, 'page should render replace action');
  assert(host.innerHTML.indexOf('重新应用') !== -1, 'page should render reapply action');

  await host.lastApplyHandler('sol_truth', { mode: 'replace', department_id: 'dept_marketing' });
  await nextTick();

  assert(applyCalls === 1, 'apply handler should call applySolution');
  assert(applyPayloads[0].payload.mode === 'replace', 'apply handler should keep selected apply mode');
  assert(getSolutionsCalls === 2, 'apply success should re-fetch solution list');
  assert(host.innerHTML.indexOf('apply_002') !== -1, 'apply success should render backend-refreshed last_apply_record_id');
  assert(host.innerHTML.indexOf('emp_backend') !== -1, 'apply success should render backend-refreshed created_employee_ids');
  assert(host.innerHTML.indexOf('kb_backend') !== -1, 'apply success should render backend-refreshed created_knowledge_base_ids');
  assert(host.innerHTML.indexOf('已应用：4') !== -1, 'apply success should render backend-refreshed apply_count');
  assert(host.innerHTML.indexOf('emp_local') === -1, 'apply success should not leave speculative local employee ids in UI');
  assert(host.innerHTML.indexOf('最近一次提交：覆盖重建') !== -1, 'page should render last submitted apply mode notice');

  if (failed) {
    console.error('admin-solutions.test.js failed');
    failures.forEach(function (item) { console.error('- ' + item); });
    process.exit(1);
  }
  console.log('admin-solutions.test.js passed:', passed, 'assertions');
}

run().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
