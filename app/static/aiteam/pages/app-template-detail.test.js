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
    disabled: false,
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
  host._overlay = createElement('div');
  host._close = createElement('button');
  host._dismiss = createElement('button');
  host._recruit = createElement('button');
  host._tabs = [
    createElement('button'),
    createElement('button'),
    createElement('button'),
    createElement('button'),
  ];
  ['overview', 'skills', 'knowledge', 'memory'].forEach(function (key, index) {
    host._tabs[index].setAttribute('data-template-detail-tab', key);
  });
  host.querySelector = function (selector) {
    if (selector === '[data-template-detail-dismiss]') return this._overlay;
    if (selector === '[data-template-detail-close]') return this._close;
    if (selector === '[data-template-detail-dismiss-action]') return this._dismiss;
    if (selector === '[data-template-detail-recruit]') return this._recruit;
    return null;
  };
  host.querySelectorAll = function (selector) {
    if (selector === '[data-template-detail-tab]') return this._tabs;
    return [];
  };
  return host;
}

function assert(condition, message) {
  if (!condition) {
    failures.push(message);
    failed += 1;
  } else {
    passed += 1;
  }
}

function nextTick() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

const templateDetail = {
  template_id: 'tpl_marketing_v1',
  name: '营销分析师 · 李明',
  category: 'marketing',
  description: '专注于市场数据分析、竞品研究、营销策略制定，能帮你完成数据报告、洞察提炼和方案撰写。',
  preview_avatar_url: 'https://cdn.example.com/avatar.png',
  default_model_ref: { provider: 'openai', model: 'gpt-4o' },
  default_skills: ['数据分析', 'PPT生成', 'Excel分析', '竞品研究'],
  tags: ['数据分析', 'PPT生成', 'Excel分析', '竞品研究'],
  default_memory_config: { type: 'conversation scoped', max_tokens: 8000 },
  knowledge_bindings: [{ knowledge_id: 'kb_growth_playbook', scope: 'enterprise' }],
  connector_requirements: [{ connector_type: 'web_search', required: false }],
  price_tier: 'standard',
  usage_stats: { total_recruits: 1234, active_instances: 86 },
};

const apiCalls = [];
const recruitCalls = [];
let confirmCalls = 0;
const assignedUrls = [];

const context = {
  window: {
    location: {
      pathname: '/app/marketplace/tpl_marketing_v1',
      assign(url) {
        assignedUrls.push(url);
      },
    },
    confirm() {
      confirmCalls += 1;
      return true;
    },
    aiteam: {
      api: {
        getTemplate(templateId) {
          apiCalls.push(templateId);
          return Promise.resolve({ ok: true, data: JSON.parse(JSON.stringify(templateDetail)) });
        },
        recruit(body) {
          recruitCalls.push(body);
          return Promise.resolve({ ok: true, data: {
            employee_id: 'emp_new_001',
            conversation_id: 'conv_new_001',
            navigation: {
              workbench: '/app/workbench',
              employee_admin: '/admin/employees?employee_id=emp_new_001',
              chat: '/app/chat/conv_new_001',
            },
          } });
        },
      },
      states: {
        renderLoading(container, message) {
          container.loadingMessage = message;
        },
        renderError(container, message) {
          container.errorMessage = message;
        },
        handleApiResult(result, container) {
          container.apiError = result;
        },
      },
    },
  },
  console,
  setTimeout,
  clearTimeout,
};
context.global = context;
context.globalThis = context;

const code = fs.readFileSync(path.join(__dirname, 'app-template-detail.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const page = context.window.aiteam.pages && context.window.aiteam.pages.appTemplateDetail;
let passed = 0;
let failed = 0;
const failures = [];

async function run() {
  assert(!!page, 'appTemplateDetail page should register');
  assert(typeof page.init === 'function', 'appTemplateDetail.init should exist');

  const host = createHost();
  page.init(host, { pathname: '/app/marketplace/tpl_marketing_v1' });
  await nextTick();

  assert(host.loadingMessage === '加载模板详情...', 'init should render loading state before the first response');
  assert(apiCalls[0] === 'tpl_marketing_v1', 'init should request the template detail by route id');
  assert(host.innerHTML.indexOf('营销分析师 · 李明') !== -1, 'page should render the template name');
  assert(host.innerHTML.indexOf('基本信息') !== -1, 'page should render the tab strip');
  assert(host.innerHTML.indexOf('能力标签') !== -1, 'overview tab should render capability tags section');
  assert(host.innerHTML.indexOf('底层大模型') !== -1, 'overview tab should render capability explanation facts');
  assert(host.innerHTML.indexOf('企业已招募') !== -1, 'overview tab should render usage stats');

  host._tabs[1].dispatchEvent({ type: 'click' });
  assert(host.innerHTML.indexOf('技能列表') !== -1, 'skills tab should render skills content');
  assert(host.innerHTML.indexOf('web_search') !== -1 || host.innerHTML.indexOf('数据分析') !== -1, 'skills tab should render skill items');

  host._tabs[2].dispatchEvent({ type: 'click' });
  assert(host.innerHTML.indexOf('kb_growth_playbook') !== -1, 'knowledge tab should render knowledge bindings');

  host._tabs[3].dispatchEvent({ type: 'click' });
  assert(host.innerHTML.indexOf('conversation scoped') !== -1, 'memory tab should render memory config');

  host._tabs[0].dispatchEvent({ type: 'click' });
  host._recruit.dispatchEvent({ type: 'click' });
  await nextTick();
  assert(confirmCalls === 1, 'clicking recruit should ask for confirmation once');
  assert(recruitCalls.length === 1, 'clicking recruit should call POST /recruitments');
  assert(recruitCalls[0].template_id === 'tpl_marketing_v1', 'recruit call should reuse template id');
  assert(recruitCalls[0].idempotency_key === 'recruit-tpl_marketing_v1', 'detail recruit should reuse the marketplace idempotency contract');
  assert(host.innerHTML.indexOf('招募成功，已创建员工 emp_new_001') !== -1, 'successful recruitment should render unified success feedback');
  assert(host.innerHTML.indexOf('已招募') !== -1, 'successful recruitment should disable CTA with success copy');
  assert(host.innerHTML.indexOf('/app/workbench') !== -1, 'successful recruitment should surface workbench follow-up CTA');
  assert(host.innerHTML.indexOf('/admin/employees?employee_id=emp_new_001') !== -1, 'successful recruitment should surface employee-admin follow-up CTA');
  assert(host.innerHTML.indexOf('/app/chat/conv_new_001') !== -1, 'successful recruitment should surface direct chat CTA');

  host._close.dispatchEvent({ type: 'click' });
  host._dismiss.dispatchEvent({ type: 'click' });
  host._overlay.dispatchEvent({ type: 'click' });
  assert(assignedUrls.length >= 3, 'close, dismiss action, and overlay should all navigate back to marketplace');
  assert(assignedUrls.every(function (url) { return url === '/app/marketplace'; }), 'dismiss actions should navigate back to /app/marketplace');

  if (failed) {
    console.error('FAIL app-template-detail.test.js');
    failures.forEach(function (failure) { console.error(' - ' + failure); });
    process.exit(1);
  }
  console.log('PASS app-template-detail.test.js (' + passed + ' assertions)');
}

run().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
