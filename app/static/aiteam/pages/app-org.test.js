'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

const documentStub = {
  getElementById() { return null; },
};

const context = {
  window: { aiteam: {} },
  document: documentStub,
  console,
  setTimeout,
  clearTimeout,
};
context.global = context;
context.globalThis = context;

const code = fs.readFileSync(path.join(__dirname, 'app-org.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const page = context.window.aiteam.pages && context.window.aiteam.pages.appOrg;

test('org page renders a visual tree chart with nodes', function () {
  assert.ok(page, 'org page should register');
  assert.strictEqual(typeof page._renderOrg, 'function', 'expected _renderOrg test export');

  const payload = {
    departments: [{
      name: '市场部',
      members: [{ name: '张三', role: '营销分析师', presence: 'online' }],
    }],
  };
  const main = { innerHTML: '' };
  page._renderOrg(main, payload);

  assert.ok(main.innerHTML.includes('aiteam-org__chart'), 'expected chart container');
  assert.ok(main.innerHTML.includes('aiteam-org__node'), 'expected tree node');
});

test('org page still surfaces editable assignment controls (PATCH preserved)', function () {
  const payload = {
    departments: [{
      name: '市场部',
      members: [{
        name: '张三',
        role: '营销分析师',
        presence: 'online',
        can_edit: true,
        assignment_id: 'a-1',
        patch_field: 'department_id',
        department_choices: [{ id: 'd-1', name: '市场部' }, { id: 'd-2', name: '研发部' }],
      }],
    }],
  };
  const main = { innerHTML: '' };
  page._renderOrg(main, payload);

  assert.ok(main.innerHTML.includes('data-org-assignment-save="a-1"'), 'expected assignment save control');
  assert.ok(main.innerHTML.includes('data-org-assignment-select="a-1"'), 'expected assignment select');
});
