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
    aiteam: {
      api: {
        getAdminTemplates() {
          apiCalls.push('templates');
          return Promise.resolve({ ok: true, data: { items: [
            { template_id: 'tpl_marketing', name: '营销分析师', role: 'marketing_analyst', category: 'marketing', description: '负责营销分析', recruit_count: 3, is_recruited: true, tags: ['营销'] },
            { template_id: 'tpl_finance', name: '财务顾问', role: 'finance_advisor', category: 'finance', description: '负责财务分析', recruit_count: 0, is_recruited: false, tags: ['财务'] },
          ] } });
        },
        recruit(body) {
          apiCalls.push('recruit:' + JSON.stringify(body));
          return Promise.resolve({
            ok: true,
            data: {
              order_id: 'ord_1',
              employee_id: 'emp_new',
              navigation: {
                workbench: '/app/workbench',
                chat: '/app/chat/conv_emp_new',
              },
            },
          });
        },
      },
      states: {
        renderLoading(container) {
          container.innerHTML = '<div>loading</div>';
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

const code = fs.readFileSync(path.join(__dirname, 'admin-templates.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const page = context.window.aiteam.pages && context.window.aiteam.pages.adminTemplates;
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
  assert(!!page, 'adminTemplates page should register');
  assert(typeof page.init === 'function', 'adminTemplates.init should exist');
  assert(page.__test && typeof page.__test.createController === 'function', 'adminTemplates should expose test controller');

  const normalized = page.__test.normalizeTemplate({ template_id: 'tpl_ops', name: '运营专家', role: 'ops', category: 'ops', recruit_count: 1, is_recruited: true });
  assert(normalized.template_id === 'tpl_ops', 'normalizeTemplate should keep template_id');
  assert(normalized.is_recruited === true, 'normalizeTemplate should keep recruited state');

  const host = createElement('div');
  page.init(host);
  await new Promise(function (resolve) { setTimeout(resolve, 0); });

  assert(apiCalls[0] === 'templates', 'page should request admin templates on init');
  assert(host.innerHTML.indexOf('人才市场') !== -1, 'page should render title');
  assert(host.innerHTML.indexOf('营销分析师') !== -1, 'page should render template item');
  assert(host.innerHTML.indexOf('立即招募') !== -1, 'page should render recruit action');
  assert(host.innerHTML.indexOf('/app/marketplace/tpl_marketing') !== -1, 'page should link to frontend template detail');
  assert(host.innerHTML.indexOf('已招募') !== -1, 'recruited templates should render a clear recruited badge');

  const controllerHost = createElement('div');
  const controller = page.__test.createController(controllerHost);
  await controller.load();
  await controller.__test.recruitTemplate('tpl_marketing');
  assert(apiCalls.indexOf('recruit:{"template_id":"tpl_marketing","display_name":"新招募员工","idempotency_key":"admin-template-recruit-tpl_marketing"}') !== -1, 'recruitTemplate should post canonical recruit payload');
  assert(controllerHost.innerHTML.indexOf('/app/chat/conv_emp_new') !== -1, 'successful recruit should expose a direct chat CTA');
  assert(controllerHost.innerHTML.indexOf('开始私聊') !== -1, 'successful recruit should label the direct chat CTA');

  if (failed) {
    console.error('admin-templates.test.js failed');
    failures.forEach(function (item) { console.error('- ' + item); });
    process.exit(1);
  }
  console.log('admin-templates.test.js passed:', passed, 'assertions');
}

run().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
