'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createElement(tag) {
  return {
    tagName: String(tag || '').toUpperCase(),
    children: [],
    style: {},
    hidden: false,
    innerHTML: '',
    textContent: '',
    appendChild(child) {
      this.children.push(child);
      this._lastChild = child;
      return child;
    },
  };
}

const nodes = {
  '#aiteam-app': createElement('div'),
  '#toast': createElement('div'),
  '#aiteam-shell-title': createElement('div'),
  '#aiteam-shell-subtitle': createElement('div'),
  '#aiteam-nav': createElement('div'),
  '#aiteam-main': createElement('div'),
  '.app-titlebar': createElement('div'),
  '.layout': createElement('div'),
};

const document = {
  head: createElement('head'),
  createElement,
  querySelector(selector) {
    return nodes[selector] || null;
  },
  getElementById(id) {
    return nodes['#' + id] || null;
  },
};

const context = {
  window: { aiteam: {}, location: { pathname: '/admin/skills' } },
  document,
  console,
  bodyClassManager: { add() {} },
};
context.global = context;
context.globalThis = context;

const code = fs.readFileSync(path.join(__dirname, 'page-shell.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const shell = context.window.aiteam.shell;
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

assert(shell && typeof shell.init === 'function', 'shell.init should exist');
shell.init('/admin/skills');
assert(nodes['#aiteam-nav'].innerHTML.indexOf('/admin/skills') !== -1, 'admin nav should include /admin/skills');
assert(document.head._lastChild && document.head._lastChild.src === 'static/aiteam/pages/admin-skills.js', 'shell should lazy-load admin-skills.js for /admin/skills');

if (failed) {
  console.error('page-shell-admin-routing.test.js failed');
  failures.forEach(function (item) { console.error('- ' + item); });
  process.exit(1);
}
console.log('page-shell-admin-routing.test.js passed:', passed, 'assertions');
