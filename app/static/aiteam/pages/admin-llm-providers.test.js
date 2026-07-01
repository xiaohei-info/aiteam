'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const PAGE_PATH = path.resolve(__dirname, 'admin-llm-providers.js');

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
    querySelector(sel) {
      for (const c of this.children) {
        if (c && c.attributes && c.attributes['data-role'] && sel.indexOf(c.attributes['data-role']) !== -1) {
          return c;
        }
      }
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      for (const c of this.children) {
        if (c && c.attributes) {
          for (const key of Object.keys(c.attributes)) {
            if (key === 'data-role' && sel.indexOf(c.attributes[key]) !== -1) out.push(c);
          }
        }
      }
      return out;
    },
  };
  el.classList = { add() {}, remove() {}, toggle() { return false; } };
  return el;
}

const apiCalls = [];
let confirmResult = true;
const context = {
  window: {
    aiteam: { pages: {} },
    confirm: function () { return confirmResult; },
    alert: function () {},
  },
  document: null,
  console,
  setTimeout,
  clearTimeout,
};
const document = {
  body: createElement('body'),
  head: createElement('head'),
  createElement,
};
context.document = document;
context.window.document = document;
context.global = context;
context.globalThis = context;
context.window.aiteam.role = {
  getActiveRole: function () { return 'enterprise_admin'; },
  hasPermission: function () { return true; },
};
context.window.aiteam.api = {
  getLlmProviders() {
    apiCalls.push('getLlmProviders');
    return Promise.resolve({ ok: true, data: { providers: [
      {
        provider_id: 'llmp_1', provider_key: 'newapi-openai', display_name: 'MyNewAPI',
        base_url: 'https://x/v1', api_key_mask: '已配置', transport: 'openai_chat',
        enabled: true,
        models: [
          { model_uid: 'llmm_1', model_id: 'gpt-5.4', label: 'GPT-5.4', context_length: 200000, is_default: true },
        ],
      },
      {
        provider_id: 'llmp_2', provider_key: 'anthropic-claude', display_name: 'Anthropic',
        base_url: 'https://api.anthropic.com', api_key_mask: '未配置', transport: 'anthropic_messages',
        enabled: false,
        models: [],
      },
    ] } });
  },
  createLlmProvider(body) {
    apiCalls.push('create:' + JSON.stringify(body));
    return Promise.resolve({ ok: true, data: { provider_id: 'llmp_new' } });
  },
  updateLlmProvider(pid, body) {
    apiCalls.push('update:' + pid + ':' + JSON.stringify(body));
    return Promise.resolve({ ok: true, data: { provider_id: pid } });
  },
  deleteLlmProvider(pid) {
    apiCalls.push('delete_provider:' + pid);
    return Promise.resolve({ ok: true });
  },
  addLlmModel(pid, body) {
    apiCalls.push('add_model:' + pid + ':' + JSON.stringify(body));
    return Promise.resolve({ ok: true, data: { model_uid: 'llmm_new_x' } });
  },
  deleteLlmModel(mid) {
    apiCalls.push('delete_model:' + mid);
    return Promise.resolve({ ok: true });
  },
};

const code = fs.readFileSync(PAGE_PATH, 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const page = context.window.aiteam.pages.adminLlmProviders;
let passed = 0, failed = 0;
const failures = [];
function assert(condition, message) {
  if (condition) passed += 1;
  else { failed += 1; failures.push(message); }
}

async function run() {
  const t = page.__test;

  // Render card with provider that has models
  const card = t.renderProviderCard({
    provider_id: 'llmp_1', provider_key: 'newapi-openai', display_name: 'MyNewAPI',
    base_url: 'https://x/v1', api_key_mask: '已配置', transport: 'openai_chat',
    enabled: true,
    models: [
      { model_uid: 'llmm_1', model_id: 'gpt-5.4', label: 'GPT-5.4', context_length: 200000, is_default: true },
    ],
  });
  assert(card.indexOf('data-role="llm-edit-provider"') !== -1, 'card should render edit button');
  assert(card.indexOf('data-role="llm-del-provider"') !== -1, 'card should render delete button');
  assert(card.indexOf('data-role="llm-del-model"') !== -1, 'card should render per-model delete button');
  assert(card.indexOf('data-role="llm-add-model-form"') !== -1, 'card should render add-model form');
  assert(card.indexOf('data-role="llm-edit-provider-form"') !== -1, 'card should render edit-provider form');
  assert(card.indexOf('MyNewAPI') !== -1, 'card should render provider display name');
  assert(card.indexOf('gpt-5.4') !== -1, 'card should render model id');
  assert(card.indexOf('newapi-openai') !== -1, 'card should render provider key');
  assert(card.indexOf('value="MyNewAPI"') !== -1, 'edit form should prefill display_name');
  assert(card.indexOf('value="https://x/v1"') !== -1, 'edit form should prefill base_url');
  assert(card.indexOf('留空则不修改') !== -1, 'edit form should show api_key hint');
  assert(card.indexOf('>openai_chat</option>') !== -1, 'edit form should render transport select');

  // Integration: init() should load providers and render page with expected roles
  const host = createElement('div');
  page.init(host);
  await new Promise(function (r) { setTimeout(r, 10); });
  assert(apiCalls.indexOf('getLlmProviders') !== -1, 'init should call getLlmProviders');
  assert(host.innerHTML.indexOf('data-role="llm-edit-provider"') !== -1, 'init should render edit buttons');

  if (failed > 0) {
    console.error('FAILED: ' + failures.length);
    failures.forEach(function (f) { console.error('  - ' + f); });
    process.exit(1);
  } else {
    console.log('ALL PASSED: ' + passed);
  }
}

run().catch(function (err) {
  console.error('RUN ERROR', err && err.stack || err);
  process.exit(2);
});
