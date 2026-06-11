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
  host._searchForm = createElement('form');
  host._searchInput = createElement('input');
  host._sortSelect = createElement('select');
  host._loadMoreButton = createElement('button');
  host._categoryButtons = [createElement('button')];
  host._categoryButtons[0].setAttribute('data-marketplace-category', 'marketing');
  host._recruitButtons = [createElement('button')];
  host._recruitButtons[0].setAttribute('data-recruit-template', 'tpl_marketing_v1');
  host._recruitButtons[0].setAttribute('data-recruit-name', '营销分析师');
  host.querySelector = function (selector) {
    if (selector === '[data-marketplace-search-form]') return this._searchForm;
    if (selector === '[data-marketplace-search-input]') return this._searchInput;
    if (selector === '[data-marketplace-sort]') return this._sortSelect;
    if (selector === '[data-marketplace-load-more]') return this._loadMoreButton;
    return null;
  };
  host.querySelectorAll = function (selector) {
    if (selector === '[data-marketplace-category]') return this._categoryButtons;
    if (selector === '[data-recruit-template]') return this._recruitButtons;
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

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

const responses = [
  {
    ok: true,
    data: {
      items: [{
        template_id: 'tpl_marketing_v1',
        name: '营销分析师',
        role: '市场分析',
        description: '擅长竞品、增长、用户洞察',
        default_model_ref: { provider: 'openai', model: 'gpt-4o' },
        skills: ['web_search', 'slides'],
        tags: ['营销', '策略'],
        category: 'marketing',
        recruit_count: 1234,
        is_recruited: false,
      }],
      page: 1,
      page_size: 20,
      total: 21,
      has_more: true,
    },
  },
  {
    ok: true,
    data: {
      items: [{
        template_id: 'tpl_finance_v1',
        name: '财务顾问',
        role: '财务分析',
        description: '擅长预算、核算与报表复盘',
        default_model_ref: { provider: 'anthropic', model: 'claude-3.5' },
        skills: ['forecasting'],
        tags: ['财务'],
        category: 'finance',
        recruit_count: 987,
        is_recruited: false,
      }],
      page: 2,
      page_size: 20,
      total: 21,
      has_more: false,
    },
  },
  {
    ok: true,
    data: {
      items: [{
        template_id: 'tpl_marketing_v1',
        name: '营销分析师',
        role: '市场分析',
        description: '擅长竞品、增长、用户洞察',
        default_model_ref: { provider: 'openai', model: 'gpt-4o' },
        skills: ['web_search', 'slides'],
        tags: ['营销', '策略'],
        category: 'marketing',
        recruit_count: 1234,
        is_recruited: false,
      }],
      page: 1,
      page_size: 20,
      total: 1,
      has_more: false,
    },
  },
  {
    ok: true,
    data: {
      items: [{
        template_id: 'tpl_marketing_v1',
        name: '营销分析师',
        role: '市场分析',
        description: '擅长竞品、增长、用户洞察',
        default_model_ref: { provider: 'openai', model: 'gpt-4o' },
        skills: ['web_search', 'slides'],
        tags: ['营销', '策略'],
        category: 'marketing',
        recruit_count: 1234,
        is_recruited: false,
      }],
      page: 1,
      page_size: 20,
      total: 1,
      has_more: false,
    },
  },
];

const apiCalls = [];
const recruitCalls = [];
let confirmCalls = 0;
let replacedUrl = null;
let assignedUrl = null;

const context = {
  window: {
    location: {
      href: 'http://localhost/app/marketplace',
      search: '',
    },
    history: {
      replaceState(_state, _title, url) {
        replacedUrl = url;
      },
    },
    confirm() {
      confirmCalls += 1;
      return true;
    },
    setTimeout,
    clearTimeout,
    aiteam: {
      api: {
        getTalentTemplates(options) {
          apiCalls.push(options || null);
          return Promise.resolve(responses.shift() || { ok: true, data: { items: [], page: 1, page_size: 20, total: 0, has_more: false } });
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
  URL,
  URLSearchParams,
  console,
  setTimeout,
  clearTimeout,
};
context.global = context;
context.globalThis = context;

const code = fs.readFileSync(path.join(__dirname, 'app-marketplace.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const page = context.window.aiteam.pages && context.window.aiteam.pages.appMarketplace;
let passed = 0;
let failed = 0;
const failures = [];

async function run() {
  assert(!!page, 'appMarketplace page should register');
  assert(typeof page.init === 'function', 'appMarketplace.init should exist');

  const host = createHost();
  page.init(host);
  await nextTick();

  assert(host.loadingMessage === '加载人才市场...', 'init should render loading state before the first response');
  assert(apiCalls[0] && apiCalls[0].query && apiCalls[0].query.sort_by === 'popularity', 'initial request should default to popularity sort');
  assert(apiCalls[0] && apiCalls[0].query && apiCalls[0].query.page_size === 20, 'initial request should request 20 templates');
  assert(host.innerHTML.indexOf('搜索专家名称、技能') !== -1, 'page should render the marketplace search copy from the prototype');
  assert(host.innerHTML.indexOf('营销分析师') !== -1, 'page should render the initial talent card');
  assert(host.innerHTML.indexOf('查看详情') !== -1, 'page should render the detail CTA');
  assert(host.innerHTML.includes('aiteam-marketplace-card__rating'), 'expected rating element in marketplace card');

  host._loadMoreButton.dispatchEvent({ type: 'click' });
  await nextTick();
  assert(apiCalls[1] && apiCalls[1].query && apiCalls[1].query.page === 2, 'clicking load more should request the next page');
  assert(host.innerHTML.indexOf('财务顾问') !== -1, 'second page results should append into the grid');

  host._searchInput.value = '营销';
  host._searchInput.dispatchEvent({ type: 'input' });
  await wait(350);
  await nextTick();
  assert(apiCalls[2] && apiCalls[2].query && apiCalls[2].query.q === '营销', 'search input should debounce and request keyword filtering');

  host._categoryButtons[0].dispatchEvent({ type: 'click' });
  await nextTick();
  assert(apiCalls[3] && apiCalls[3].query && apiCalls[3].query.category === 'marketing', 'clicking a category tab should request category filtering');
  assert(replacedUrl === '/app/marketplace?q=%E8%90%A5%E9%94%80&category=marketing', 'state changes should sync the marketplace URL');

  host._recruitButtons[0].dispatchEvent({ type: 'click' });
  await nextTick();
  assert(confirmCalls === 1, 'recruit should ask for confirmation once');
  assert(recruitCalls[0] && recruitCalls[0].template_id === 'tpl_marketing_v1', 'recruit button should call the recruitment endpoint with template_id');
  assert(recruitCalls[0] && recruitCalls[0].idempotency_key === 'recruit-tpl_marketing_v1', 'recruit should send a stable idempotency key');
  assert(host.innerHTML.indexOf('已招募') !== -1, 'successful recruit should rerender the disabled recruited state');
  assert(host.innerHTML.indexOf('招募成功，已创建员工 emp_new_001') !== -1, 'successful recruit should show inline success feedback');
  assert(host.innerHTML.indexOf('/app/workbench') !== -1, 'successful recruit should surface workbench follow-up CTA');
  assert(host.innerHTML.indexOf('/admin/employees?employee_id=emp_new_001') !== -1, 'successful recruit should surface employee-admin follow-up CTA');
  assert(host.innerHTML.indexOf('/app/chat/conv_new_001') !== -1, 'successful recruit should surface direct chat CTA when conversation exists');

  if (failed) {
    console.error('app-marketplace.test.js failed');
    failures.forEach(function (item) { console.error('- ' + item); });
    process.exit(1);
  }
  console.log('app-marketplace.test.js passed:', passed, 'assertions');
}

run().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
