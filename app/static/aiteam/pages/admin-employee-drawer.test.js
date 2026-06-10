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
  prompt_version: 12,
  prompt_config: {
    system_prompt: 'Stay truthful',
    opening_message: '你好，我会先核对数据。',
    behavior_rules_json: '{"tone":"direct","citation":"required"}',
  },
  recent_audit_events: [
    {
      audit_event_id: 'audit_emp_updated_001',
      actor_id: 'user_test',
      event_type: 'employee.updated',
      request_id: 'req-001',
      payload: { fields: ['display_name', 'status'], status: 'active' },
      created_at: '2026-06-02T09:10:00Z',
    },
    {
      audit_event_id: 'audit_job_pause_001',
      actor_id: 'user_test',
      event_type: 'scheduled_job.pause',
      request_id: 'req-002',
      payload: { employee_id: 'emp_test', action: 'pause' },
      created_at: '2026-06-02T09:11:00Z',
    },
  ],
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
    knowledge: ['kb_marketing_001'],
    connectors: [{ connector_id: 'conn_docs', access_mode: 'invoke', enabled: true }],
  },
  knowledge_bases: [{ knowledge_base_id: 'kb_marketing_001', scope_mode: 'read', enabled: true }],
  connector_bindings: [{ connector_id: 'conn_docs', access_mode: 'invoke', enabled: true }],
  bindings_summary: [
    { binding_type: 'model', count: 1 },
    { binding_type: 'prompt', count: 1 },
    { binding_type: 'skills', count: 0 },
    { binding_type: 'knowledge_bases', count: 1 },
    { binding_type: 'memory', count: 1 },
    { binding_type: 'connectors', count: 1 },
    { binding_type: 'loop', count: 1 },
  ],
  scheduled_jobs: [{
    scheduled_job_id: 'job_daily',
    name: 'Daily monitor',
    goal: 'Check service status every morning',
    schedule_expr: '0 9 * * *',
    status: 'enabled',
    max_consecutive_failures: 3,
    consecutive_failures: 1,
    last_run_status: 'succeeded',
    last_run_at: '2026-06-02T09:00:00Z',
    last_success_at: '2026-06-02T09:00:00Z',
    runtime_job_id: 'job_daily',
    notification_policy: { on_failure: 'email' },
  }],
  run_summary: {
    latest_run_id: 'run_latest_001',
    latest_status: 'succeeded',
    latest_trigger_type: 'scheduled_job',
    latest_finished_at: '2026-06-02T09:00:05Z',
    total_runs: 12,
    total_tokens: 3456,
    total_cost_cents: 78,
    last_run_at: '2026-06-02T09:00:00Z',
  },
  conversation_bindings: [],
  usage_summary: { total_runs: 12, total_tokens: 3456, last_run_at: '2026-06-02T09:00:00Z' },
  created_at: '2026-06-02T00:00:00Z',
};

const context = {
  window: {
    aiteam: {
      __updateEmployeeCalls: [],
      api: {
        getEmployee() {
          return Promise.resolve({ ok: true, data: employeeResponse });
        },
        updateEmployee(employeeId, body) {
          context.window.aiteam.__updateEmployeeCalls.push({ employeeId, body });
          return Promise.resolve({
            ok: true,
            data: Object.assign({
              employee_id: employeeId,
              status: employeeResponse.status,
              display_name: employeeResponse.display_name,
            }, body),
          });
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
  assert(Array.isArray(drawer.TABS) && drawer.TABS.length === 8, 'drawer should expose 8 tabs');

  const normalized = drawer.normalizeEmployeePayload(employeeResponse);
  assert(normalized.modelProvider === 'openai', 'normalize should read model provider from top-level model_provider');
  assert(normalized.modelName === 'gpt-4o-mini', 'normalize should read model name from top-level model_name');
  assert(normalized.systemPrompt === 'Stay truthful', 'normalize should read truthful prompt_config.system_prompt');
  assert(normalized.openingMessage === '你好，我会先核对数据。', 'normalize should read truthful prompt_config.opening_message');
  assert(normalized.behaviorRuleLabels.indexOf('tone: direct') !== -1, 'normalize should parse truthful behavior rules from prompt_config');
  assert(normalized.skillCodes.length === 0, 'normalize should have empty skillCodes when backend returns empty skills');
  assert(normalized.knowledgeIds.length === 1 && normalized.knowledgeIds[0] === 'kb_marketing_001', 'normalize should expose truthful knowledge ids from backend knowledge bindings');
  assert(normalized.memory && normalized.memory.mode === 'builtin', 'normalize should read memory mode from memory_config.mode');
  assert(normalized.memory && normalized.memory.providerCode === 'mem0', 'normalize should read memory provider_code from backend memory_config');
  assert(normalized.memory && normalized.memory.retentionDays === '365', 'normalize should read memory retention_days from backend memory_config');
  assert(normalized.memory && normalized.memory.writebackEnabled === '开启', 'normalize should read memory writeback_enabled from backend memory_config');
  assert(normalized.connectorNames.length === 1 && normalized.connectorNames[0] === 'conn_docs', 'normalize should expose truthful connectorNames from connector_bindings');

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

  const knowledgeTab = tabs.filter(function (item) { return item.getAttribute('data-tab') === 'knowledge'; })[0];
  if (knowledgeTab) {
    knowledgeTab.dispatchEvent({ type: 'click' });
  }
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('kb_marketing_001') !== -1, 'knowledge tab should render truthful knowledge base ids from backend');

  const memoryTab = tabs.filter(function (item) { return item.getAttribute('data-tab') === 'memory'; })[0];
  if (memoryTab) {
    memoryTab.dispatchEvent({ type: 'click' });
  }
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('mem0') !== -1, 'memory tab should render truthful provider_code from backend');
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('365') !== -1, 'memory tab should render truthful retention_days from backend');
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('开启') !== -1, 'memory tab should render truthful writeback_enabled from backend');

  const connectorsTab = tabs.filter(function (item) { return item.getAttribute('data-tab') === 'connectors'; })[0];
  if (connectorsTab) {
    connectorsTab.dispatchEvent({ type: 'click' });
  }
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('conn_docs') !== -1, 'connectors tab should render truthful connector bindings from backend');

  const loopTab = tabs.filter(function (item) { return item.getAttribute('data-tab') === 'loop'; })[0];
  if (loopTab) {
    loopTab.dispatchEvent({ type: 'click' });
  }
  const loopHtml = document.getElementById('aiteam-drawer-body').innerHTML;
  assert(loopHtml.indexOf('Daily monitor') !== -1, 'loop tab should render scheduled job name from backend');
  assert(loopHtml.indexOf('0 9 * * *') !== -1, 'loop tab should render scheduled job cron from backend');
  assert(loopHtml.indexOf('run_latest_001') !== -1, 'loop tab should render latest run id from backend run_summary');
  assert(loopHtml.indexOf('total_cost_cents') === -1, 'loop tab should present run summary labels instead of raw backend keys');
  assert(loopHtml.indexOf('能力装配摘要') !== -1, 'loop tab should render bindings summary section');

  const skillsTab = tabs.filter(function (item) { return item.getAttribute('data-tab') === 'skills'; })[0];
  if (skillsTab) {
    skillsTab.dispatchEvent({ type: 'click' });
  }
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('Excel分析') !== -1, 'skills tab should render installed enterprise skills');
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('授权给员工') !== -1, 'skills tab should render assignment actions');
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('提交并持久化技能绑定；刷新页面后，已授权技能仍会保留。') !== -1, 'skills tab should state that skills_add/skills_remove persists after refresh');
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('尚未持久化技能绑定') === -1, 'skills tab should not claim skills bindings are non-persistent');
  const profileTab = tabs.filter(function (item) { return item.getAttribute('data-tab') === 'profile'; })[0];
  if (profileTab) {
    profileTab.dispatchEvent({ type: 'click' });
  }
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('knowledge_base_ids') !== -1, 'profile tab copy should mention knowledge_base_ids patch support');
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('scheduled_job/scheduled_job_action') !== -1, 'profile tab copy should mention scheduled_job patch support');
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('治理审计') !== -1, 'profile tab should render governance audit section');
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('employee.updated') !== -1, 'profile tab should render recent employee audit event types');
  assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('scheduled_job.pause') !== -1, 'profile tab should render scheduled job governance audit event types');

  assert(drawer.__test && typeof drawer.__test.saveModelConfig === 'function', 'drawer test hooks should expose saveModelConfig');
  assert(drawer.__test && typeof drawer.__test.savePromptConfig === 'function', 'drawer test hooks should expose savePromptConfig');
  assert(drawer.__test && typeof drawer.__test.saveKnowledgeConfig === 'function', 'drawer test hooks should expose saveKnowledgeConfig');
  assert(drawer.__test && typeof drawer.__test.saveMemoryConfig === 'function', 'drawer test hooks should expose saveMemoryConfig');
  assert(drawer.__test && typeof drawer.__test.saveConnectorConfig === 'function', 'drawer test hooks should expose saveConnectorConfig');
  assert(drawer.__test && typeof drawer.__test.saveScheduledJobConfig === 'function', 'drawer test hooks should expose saveScheduledJobConfig');

  await drawer.__test.saveModelConfig({ model_provider: 'anthropic', model_name: 'claude-3-7-sonnet' });
  await drawer.__test.savePromptConfig({
    prompt_version: 13,
    prompt_system: 'Use evidence first',
    prompt_behavior_rules_json: '{"tone":"direct"}',
    prompt_opening_message: '开始前先核对事实。',
  });
  await drawer.__test.saveKnowledgeConfig({ knowledge_base_ids: ['kb_ops', 'kb_marketing_001'] });
  await drawer.__test.saveMemoryConfig({
    memory_mode: 'external',
    memory_provider_code: 'memx',
    memory_retention_days: 30,
    memory_writeback_enabled: false,
  });
  await drawer.__test.saveConnectorConfig({ connector_ids: ['conn_docs', 'conn_search'] });
  await drawer.__test.saveScheduledJobConfig({
    scheduled_job: {
      name: 'Morning Ops Loop',
      goal: 'Check alerts',
      schedule_expr: '0 8 * * *',
      status: 'enabled',
    },
  });

  assert(context.window.aiteam.__updateEmployeeCalls.length >= 6, 'drawer save helpers should call updateEmployee for editable tabs');
  assert(context.window.aiteam.__updateEmployeeCalls[0].body.model_provider === 'anthropic', 'model save should PATCH model_provider');
  assert(context.window.aiteam.__updateEmployeeCalls[1].body.prompt_system === 'Use evidence first', 'prompt save should PATCH prompt_system');
  assert(context.window.aiteam.__updateEmployeeCalls[2].body.knowledge_base_ids.length === 2, 'knowledge save should PATCH knowledge_base_ids');
  assert(context.window.aiteam.__updateEmployeeCalls[3].body.memory_provider_code === 'memx', 'memory save should PATCH memory settings');
  assert(context.window.aiteam.__updateEmployeeCalls[4].body.connector_ids[1] === 'conn_search', 'connector save should PATCH connector_ids');
  assert(context.window.aiteam.__updateEmployeeCalls[5].body.scheduled_job.name === 'Morning Ops Loop', 'loop save should PATCH scheduled_job');

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
