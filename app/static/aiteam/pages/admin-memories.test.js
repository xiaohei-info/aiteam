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

const apiCalls = [];

const context = {
  window: {
    prompt() { return null; },
    confirm() { return true; },
    aiteam: {
      api: {
        getMemories(options) {
          apiCalls.push({ type: 'getMemories', options: options || null });
          return Promise.resolve({ ok: true, data: { items: [
            {
              memory_id: 'mem_1', employee_id: 'emp_1', employee_name: 'Alice', content: '喜欢简洁回复', importance: 5,
              category: 'preference', tags: ['style'], created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-02T00:00:00Z',
              extraction_status: 'failed', extraction_error_message: 'writeback timeout',
              audit_trace: [{ action: 'created', actor_name: 'admin', timestamp: '2026-06-02T01:00:00Z' }],
              prompt_plan_refs: [{ run_id: 'run_1' }],
              prompt_use_trace: [{ run_id: 'run_1', event_id: 'evt_mem_1', event_cursor: 1, stage: 'prompt_injected', used_at: '2026-06-02T01:02:00Z' }],
            },
            {
              memory_id: 'mem_2', employee_id: 'emp_2', employee_name: 'Bob', content: '擅长销售', importance: 2,
              category: 'persona', tags: ['sales'], created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-03T00:00:00Z'
            },
          ] } });
        },
        get(pathname) {
          if (pathname === '/memories') return this.getMemories();
          return Promise.resolve({ ok: false, status: 404, error: 'not found' });
        },
        createMemory(body) { apiCalls.push({ type: 'createMemory', body }); return Promise.resolve({ ok: true, data: body }); },
        updateMemory(memoryId, body) { apiCalls.push({ type: 'updateMemory', memoryId, body }); return Promise.resolve({ ok: true, data: { memory_id: memoryId, content: body.content } }); },
        deleteMemory() { return Promise.resolve({ ok: true }); },
      },
    },
  },
  document,
  console,
  setTimeout,
  clearTimeout,
  setImmediate,
};
context.global = context;
context.globalThis = context;

const code = fs.readFileSync(path.join(__dirname, 'admin-memories.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const page = context.window.aiteam.pages.adminMemories;
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

const normalizedAudit = page.__test.normalizeAuditEvents({ audit_trace: [{ action: 'created', actor_name: 'admin', timestamp: '2026-06-02T01:00:00Z' }] });
assert(normalizedAudit[0].action === 'created', 'normalizeAuditEvents should parse action');
const normalizedRefs = page.__test.normalizePromptRefs({ prompt_plan_refs: [{ run_id: 'run_1' }] });
assert(normalizedRefs[0] === 'run_1', 'normalizePromptRefs should parse run refs');

const normalized = page.__test.normalizePayload({ items: [
  { memory_id: 'b', importance: 1, updated_at: '2026-01-01T00:00:00Z' },
  { memory_id: 'a', importance: 4, updated_at: '2026-02-01T00:00:00Z' },
] });
assert(normalized[0].memory_id === 'a', 'normalizePayload should sort higher importance first');

const store = page.__test.createStore([
  { memory_id: 'mem_1', employee_id: 'emp_1', employee_name: 'Alice', content: '喜欢简洁回复', importance: 5, category: 'preference', tags: ['style'], updated_at: '2026-06-01T00:00:00Z', prompt_plan_refs: ['run_1'] },
  { memory_id: 'mem_2', employee_id: 'emp_2', employee_name: 'Bob', content: '擅长销售', importance: 2, category: 'persona', tags: ['sales'], updated_at: '2026-05-01T00:00:00Z' },
]);
assert(store.filter({ employeeId: 'emp_1' }).length === 1, 'store.filter should narrow by employeeId');
assert(store.filter({ category: 'persona' })[0].memory_id === 'mem_2', 'store.filter should narrow by category');
assert(store.filter({ query: 'run_1' })[0].memory_id === 'mem_1', 'store.filter should search prompt plan refs');

(async function run() {
  const container = createElement('div');
  page.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  assert(apiCalls.length === 1, 'page should fetch memories once on init');
  assert(apiCalls[0].options && apiCalls[0].options.query && apiCalls[0].options.query.include === 'prompt_use_trace', 'page should request prompt_use_trace from backend');
  assert(apiCalls[0].options.query.trace_limit === 5, 'page should request bounded prompt trace size');
  assert(container.innerHTML.indexOf('记忆管理') !== -1, 'page should render heading');
  assert(container.innerHTML.indexOf('自动提取/写回失败') !== -1, 'page should render extraction failure visibility');
  assert(container.innerHTML.indexOf('Prompt Plan 引用') !== -1, 'page should render prompt plan section');
  assert(container.innerHTML.indexOf('使用记录') !== -1, 'page should render memory usage trace section');
  assert(container.innerHTML.indexOf('prompt_injected') !== -1, 'page should render prompt injection stage');
  assert(container.innerHTML.indexOf('操作记录') !== -1, 'page should render audit trace section');
  assert(container.innerHTML.indexOf('当前显示 2 / 2 条记忆') !== -1, 'page should render summary');
  assert(container.innerHTML.indexOf('重要程度') !== -1, 'page should render inline importance field');
  assert(container.innerHTML.indexOf('记忆分类') !== -1, 'page should render inline category field');
  assert(container.innerHTML.indexOf('标签') !== -1, 'page should render inline tags field');

  assert(typeof page.__test.createPageController === 'function', 'page should expose controller factory');
  const controller = page.__test.createPageController(createElement('div'));
  controller.state.employeeId = 'emp_1';
  controller.state.query = '简洁';
  await controller.__test.fetchRemoteMemories();
  controller.__test.setDraftMemory({
    employee_id: 'emp_1',
    content: '客户偏好 8 点前收到日报',
    importance: 4,
    category: 'preference',
    tags: ['日报', '时效'],
  });
  await controller.__test.createMemory();
  assert(apiCalls[1].options.query.employee_id === 'emp_1', 'controller should forward employee filter to backend');
  assert(apiCalls[1].options.query.q === '简洁', 'controller should forward search query to backend');
  assert(apiCalls[2].type === 'createMemory', 'controller should create memory from inline draft');
  assert(apiCalls[2].body.employee_id === 'emp_1', 'create memory should keep selected employee');
  assert(apiCalls[2].body.importance === 4, 'create memory should keep selected importance');
  assert(apiCalls[2].body.category === 'preference', 'create memory should keep selected category');
  assert(apiCalls[2].body.tags.join(',') === '日报,时效', 'create memory should submit tag list');
  if (failed) {
    console.error('admin-memories.test.js failed');
    failures.forEach(function (item) { console.error('- ' + item); });
    process.exit(1);
  }
  console.log('admin-memories.test.js passed:', passed, 'assertions');
}()).catch((error) => {
  console.error(error);
  process.exit(1);
});
