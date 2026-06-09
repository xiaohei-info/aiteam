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
        installSkill(body) {
          apiCalls.push('install:' + body.skill_code + ':' + JSON.stringify(body));
          return Promise.resolve({ ok: true, data: { skill_id: body.skill_id, name: 'Excel分析', version: '1.2.0', source: 'skillhub', visibility: 'enterprise', granted_employee_ids: [] } });
        },
        patchSkillInstall(installId, body) {
          apiCalls.push('patch:' + installId + ':' + JSON.stringify(body));
          return Promise.resolve({ ok: true, data: {
            install_id: installId,
            skill_id: 'skill_excel',
            version: body.version || '1.2.0',
            latest_version: body.latest_version || '1.3.0',
            install_status: body.version === body.latest_version ? 'active' : 'update_available',
            scope_mode: body.scope_mode || 'selected_employees',
            grants: (body.employee_ids || ['emp_1']).map(function (employeeId) {
              return { skill_code: 'skill_excel', employee_id: employeeId, enabled: true };
            }),
          } });
        },
        deleteSkillInstall(installId) {
          apiCalls.push('delete:' + installId);
          return Promise.resolve({ ok: true, data: { install_id: installId, skill_code: 'skill_excel', status: 'uninstalled' } });
        },
        getSkillCatalog() {
          apiCalls.push('catalog');
          return Promise.resolve({ ok: true, data: { items: [
            { skill_id: 'skill_excel', name: 'Excel分析', description: '处理表格', source: 'skillhub', version: '1.2.0', latest_version: '1.3.0', update_available: true, install_count: 42, tags: ['分析', '表格'], authorization_scope: 'employee_grant' },
            { skill_id: 'skill_search', name: '联网搜索', description: '联网检索', source: 'clawhub', version: '0.9.0', install_count: 11, tags: ['搜索'] },
          ] } });
        },
        getSkillInstalls() {
          apiCalls.push('installs');
          return Promise.resolve({ ok: true, data: { items: [
            { install_id: 'inst_1', skill_id: 'skill_excel', name: 'Excel分析', version: '1.2.0', latest_version: '1.3.0', update_available: true, source: 'skillhub', visibility: 'enterprise', granted_employee_ids: ['emp_1'], grants: [{ employee_id: 'emp_1', enabled: true }] },
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

const code = fs.readFileSync(path.join(__dirname, 'admin-skills.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const page = context.window.aiteam.pages && context.window.aiteam.pages.adminSkills;
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
  assert(!!page, 'adminSkills page should register');
  assert(typeof page.init === 'function', 'adminSkills.init should exist');

  const normalizedInstall = page.__test.normalizeInstall({ skill_id: 'skill_excel', granted_employee_ids: ['emp_1'] });
  assert(normalizedInstall.skill_id === 'skill_excel', 'normalizeInstall should keep skill_id');
  assert(normalizedInstall.granted_employee_ids.length === 1, 'normalizeInstall should keep grant count');

  const filtered = page.__test.filterCatalog([
    { name: 'Excel分析', description: '处理表格', skill_id: 'skill_excel', category: '', tags: ['分析'] },
    { name: '联网搜索', description: '联网检索', skill_id: 'skill_search', category: '', tags: ['搜索'] },
  ], '搜索');
  assert(filtered.length === 1 && filtered[0].skill_id === 'skill_search', 'filterCatalog should match query across fields');

  const host = createElement('div');
  page.init(host);
  await new Promise(function (resolve) { setTimeout(resolve, 0); });

  assert(apiCalls.join(',') === 'installs,catalog', 'page should request installs then catalog');
  assert(host.innerHTML.indexOf('技能市场') !== -1, 'page should render title');
  assert(host.innerHTML.indexOf('升级到最新') !== -1, 'page should render upgrade action');
  assert(host.innerHTML.indexOf('卸载技能') !== -1, 'page should render uninstall action');
  assert(host.innerHTML.indexOf('编辑授权员工') !== -1, 'page should render scope management action');
  assert(host.innerHTML.indexOf('Excel分析') !== -1, 'page should render skill card content');
  assert(host.innerHTML.indexOf('搜索技能名称、描述或标签') !== -1, 'page should render search guidance');
  assert(host.innerHTML.indexOf('安装时配置授权范围') !== -1, 'page should render install-time scope controls');
  assert(host.innerHTML.indexOf('skillhub.io') !== -1, 'page should render skillhub source badge');
  assert(host.innerHTML.indexOf('clawhub.io') !== -1, 'page should render clawhub source badge');

  assert(typeof page.__test.createController === 'function', 'page should expose controller factory for interaction tests');
  const controller = page.__test.createController(createElement('div'));
  await controller.load();
  controller.__test.setInstallScope('selected_employees', ['emp_7', 'emp_8']);
  await controller.__test.installSkill('skill_search');
  await controller.__test.upgradeInstall('inst_1');
  await controller.__test.updateScope('inst_1', 'selected_employees', ['emp_1', 'emp_2']);
  await controller.__test.uninstallInstall('inst_1');
  assert(apiCalls.indexOf('install:skill_search:{"skill_code":"skill_search","scope_mode":"selected_employees","employee_ids":["emp_7","emp_8"]}') !== -1, 'install should carry install-time employee scope');
  assert(apiCalls.indexOf('patch:inst_1:{"version":"1.3.0","latest_version":"1.3.0"}') !== -1, 'upgrade should patch install to latest version');
  assert(apiCalls.indexOf('patch:inst_1:{"scope_mode":"selected_employees","employee_ids":["emp_1","emp_2"]}') !== -1, 'scope update should patch employee scope');
  assert(apiCalls.indexOf('delete:inst_1') !== -1, 'uninstall should call deleteSkillInstall');

  if (failed) {
    console.error('admin-skills.test.js failed');
    failures.forEach(function (item) { console.error('- ' + item); });
    process.exit(1);
  }
  console.log('admin-skills.test.js passed:', passed, 'assertions');
}

run().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
