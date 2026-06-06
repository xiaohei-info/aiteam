// admin-employee-drawer.test.js
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
    remove() {
      if (!this.parentNode) return;
      const idx = this.parentNode.children.indexOf(this);
      if (idx >= 0) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    },
    setAttribute(key, value) {
      this.attributes[key] = String(value);
      if (key === 'id') documentNodesById.set(String(value), this);
    },
    getAttribute(key) {
      return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
    },
    addEventListener(type, fn) {
      this.events[type] = this.events[type] || [];
      this.events[type].push(fn);
    },
    dispatchEvent(event) {
      (this.events[event.type] || []).forEach(function (fn) { fn.call(el, event); });
    },
    querySelectorAll(selector) {
      const matches = [];
      const wanted = selector.charAt(0) === '.' ? selector.slice(1) : null;
      function walk(node) {
        if (!node || !node.children) return;
        node.children.forEach(function (child) {
          const classes = (child.className || '').split(/\s+/).filter(Boolean);
          if (wanted && classes.indexOf(wanted) !== -1) matches.push(child);
          walk(child);
        });
      }
      walk(this);
      return matches;
    },
  };
  el.classList = {
    add(cls) {
      const parts = (el.className || '').split(/\s+/).filter(Boolean);
      if (parts.indexOf(cls) === -1) parts.push(cls);
      el.className = parts.join(' ');
    },
    remove(cls) {
      const parts = (el.className || '').split(/\s+/).filter(Boolean).filter(function (item) { return item !== cls; });
      el.className = parts.join(' ');
    },
    toggle(cls, force) {
      const exists = (el.className || '').split(/\s+/).filter(Boolean).indexOf(cls) !== -1;
      const shouldAdd = force === undefined ? !exists : !!force;
      if (shouldAdd) this.add(cls);
      else this.remove(cls);
      return shouldAdd;
    },
  };
  return el;
}

const documentNodesById = new Map();
const document = {
  body: createElement('body'),
  head: createElement('head'),
  createElement,
  getElementById(id) {
    return documentNodesById.get(String(id)) || null;
  },
};

const employeeResponse = {
  employee_id: 'emp_test',
  display_name: 'Test Analyst',
  role_name: '市场分析',
  status: 'active',
  presence: 'idle',
  model_provider: 'openai',
  model_name: 'gpt-4o-mini',
  prompt_version: 3,
  prompt_config: {
    system_prompt: 'Stay truthful',
    opening_message: '你好，我会先核对数据。',
    behavior_rules_json: '{"tone":"direct","citation":"required"}',
  },
  profile_config: {
    profile_name: 'emp-test',
    skills: [],
    memory_config: {
      mode: 'builtin',
      provider_code: 'mem0',
      retention_days: 365,
      writeback_enabled: true,
      binding_version: 7,
      max_tokens: 8000,
    },
  },
  connector_bindings: [],
  conversation_bindings: [],
  usage_summary: { total_runs: 0, total_tokens: 0, last_run_at: null },
  created_at: '2026-06-02T00:00:00Z',
};

const context = {
  window: {
    aiteam: {
      api: {
        getEmployee() {
          return Promise.resolve({ ok: true, data: employeeResponse });
        },
        getSkillInstalls() {
          return Promise.resolve({ ok: true, data: { items: [
            {
              install_id: 'inst_skill_excel',
              skill_id: 'excel-analysis',
              name: 'Excel分析',
              version: '1.0.0',
              source: 'skillhub',
              visibility: 'enterprise',
              granted_employee_ids: [],
            },
          ] } });
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

const code = fs.readFileSync(path.join(__dirname, 'admin-employee-drawer.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const drawer = context.window.aiteam.pages.adminEmployeeDrawer;
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
  assert(!!drawer, 'drawer module should register on aiteam.pages');
  assert(typeof drawer.init === 'function', 'drawer.init should exist');
  assert(typeof drawer.open === 'function', 'drawer.open should exist');
  assert(typeof drawer.close === 'function', 'drawer.close should exist');
  assert(Array.isArray(drawer.TABS) && drawer.TABS.length === 7, 'drawer should expose 7 tabs');

  const normalized = drawer.normalizeEmployeePayload(employeeResponse);
  assert(normalized.modelProvider === 'openai', 'normalize should read model provider from top-level model_provider');
  assert(normalized.modelName === 'gpt-4o-mini', 'normalize should read model name from top-level model_name');
  assert(normalized.systemPrompt === 'Stay truthful', 'normalize should read truthful prompt_config.system_prompt');
  assert(normalized.openingMessage === '你好，我会先核对数据。', 'normalize should read truthful prompt_config.opening_message');
  assert(normalized.behaviorRuleLabels.indexOf('tone: direct') !== -1, 'normalize should parse truthful behavior rules from prompt_config');
  assert(normalized.skillCodes.length === 0, 'normalize should have empty skillCodes when backend returns empty skills');
  assert(normalized.knowledgeIds.length === 0, 'normalize should have empty knowledgeIds when backend has no knowledge in profile_config');
  assert(normalized.memory && normalized.memory.mode === 'builtin', 'normalize should read memory mode from memory_config.mode');
  assert(normalized.memory && normalized.memory.providerCode === 'mem0', 'normalize should read memory provider_code from backend memory_config');
  assert(normalized.memory && normalized.memory.retentionDays === '365', 'normalize should read memory retention_days from backend memory_config');
  assert(normalized.memory && normalized.memory.writebackEnabled === '开启', 'normalize should read memory writeback_enabled from backend memory_config');
  assert(normalized.connectorNames.length === 0, 'normalize should have empty connectorNames when connector_bindings is empty');

  const host = createElement('div');
  drawer.init(host);
  drawer.open('emp_test');
  await new Promise(function (resolve) { setTimeout(resolve, 0); });

  assert(host.children.length === 2, 'open should append overlay and drawer');
  assert(document.getElementById('aiteam-drawer-body') !== null, 'open should register drawer body element');

  const tabs = host.children[1].querySelectorAll('.aiteam-drawer__tab');
  const promptTab = tabs.filter(function (item) { return item.getAttribute('data-tab') === 'prompt'; })[0];
  if (promptTab) {
    promptTab.dispatchEvent({ type: 'click' });
  }
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('Stay truthful') !== -1, 'prompt tab should render truthful system prompt from backend');
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('tone: direct') !== -1, 'prompt tab should render truthful behavior rules from backend');

  const memoryTab = tabs.filter(function (item) { return item.getAttribute('data-tab') === 'memory'; })[0];
  if (memoryTab) {
    memoryTab.dispatchEvent({ type: 'click' });
  }
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('mem0') !== -1, 'memory tab should render truthful provider_code from backend');
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('365') !== -1, 'memory tab should render truthful retention_days from backend');
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('开启') !== -1, 'memory tab should render truthful writeback_enabled from backend');

  const skillsTab = tabs.filter(function (item) { return item.getAttribute('data-tab') === 'skills'; })[0];
  if (skillsTab) {
    skillsTab.dispatchEvent({ type: 'click' });
  }
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('Excel分析') !== -1, 'skills tab should render installed enterprise skills');
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('授权给员工') !== -1, 'skills tab should render assignment actions');
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('提交并持久化技能绑定；刷新页面后，已授权技能仍会保留。') !== -1, 'skills tab should state that skills_add/skills_remove persists after refresh');
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('尚未持久化技能绑定') === -1, 'skills tab should not claim skills bindings are non-persistent');

  drawer.close();
  assert(host.children.length === 0, 'close should remove overlay and drawer');

  if (failed) {
    console.error('admin-employee-drawer.test.js failed');
    failures.forEach(function (item) { console.error('- ' + item); });
    process.exit(1);
  }
  console.log('admin-employee-drawer.test.js passed:', passed, 'assertions');
}

run().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
