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

const code = fs.readFileSync(path.join(__dirname, 'knowledge.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const page = context.window.aiteam.pages && context.window.aiteam.pages.knowledge;

test('knowledge page renders stats bar and per-card progress bar', function () {
  assert.ok(page, 'knowledge page should register');
  assert.strictEqual(typeof page._renderInto, 'function', 'expected _renderInto test export');

  const kbList = [{
    knowledge_base_id: 'kb1',
    name: 'KB1',
    description: '',
    status: 'ready',
    document_count: 5,
    documents: [],
    employee_bindings: [],
  }];
  const container = { innerHTML: '' };
  page._renderInto(container, kbList, []);

  assert.ok(container.innerHTML.includes('aiteam-kb-stats'), 'expected stats bar');
  assert.ok(container.innerHTML.includes('aiteam-kb-card__bar'), 'expected card progress bar');
});
