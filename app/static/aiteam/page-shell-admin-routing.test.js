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

context.window.location.pathname = '/admin/employees/emp_7/loop';
shell.init('/admin/employees/emp_7/loop');
assert(nodes['#aiteam-nav'].innerHTML.indexOf('/admin/employees') !== -1, 'admin nav should include /admin/employees for nested employee detail routes');
assert(document.head._lastChild && document.head._lastChild.src === 'static/aiteam/pages/admin-employees.js', 'shell should lazy-load admin-employees.js for nested employee detail routes');

// Regression: /app/workbench must lazy-load app-workbench.js via the regex
// table (previously fell through to "页面模块加载失败").

context.window.location.pathname = '/admin/collaboration';
shell.init('/admin/collaboration');
assert(nodes['#aiteam-nav'].innerHTML.indexOf('/admin/collaboration') !== -1, 'admin nav should include /admin/collaboration');
assert(document.head._lastChild && document.head._lastChild.src === 'static/aiteam/pages/admin-collaboration.js', 'shell should lazy-load admin-collaboration.js for /admin/collaboration');

context.window.location.pathname = '/app/workbench';
shell.init('/app/workbench');
assert(document.head._lastChild && document.head._lastChild.src === 'static/aiteam/pages/app-workbench.js', 'shell should lazy-load app-workbench.js for /app/workbench');

context.window.location.pathname = '/app/marketplace';
shell.init('/app/marketplace');
assert(document.head._lastChild && document.head._lastChild.src === 'static/aiteam/pages/app-marketplace.js', 'shell should lazy-load app-marketplace.js for /app/marketplace');

context.window.location.pathname = '/app/group';
shell.init('/app/group');
assert(document.head._lastChild && document.head._lastChild.src === 'static/aiteam/pages/app-group.js', 'shell should lazy-load app-group.js for /app/group');

// Icon rail: nav renders rail items carrying hrefs and tooltips.

context.window.location.pathname = '/admin/collaboration';
shell.init('/admin/collaboration');
assert(nodes['#aiteam-nav'].innerHTML.indexOf('/admin/collaboration') !== -1, 'admin nav should include /admin/collaboration');
assert(document.head._lastChild && document.head._lastChild.src === 'static/aiteam/pages/admin-collaboration.js', 'shell should lazy-load admin-collaboration.js for /admin/collaboration');

context.window.location.pathname = '/app/workbench';
shell.init('/app/workbench');
assert(nodes['#aiteam-nav'].innerHTML.indexOf('aiteam-rail__item') !== -1, 'app nav should render icon-rail items');
assert(nodes['#aiteam-nav'].innerHTML.indexOf('/app/chat') !== -1, 'app nav should include /app/chat href');

if (failed) {
  console.error('page-shell-admin-routing.test.js failed');
  failures.forEach(function (item) { console.error('- ' + item); });
  process.exit(1);
}
console.log('page-shell-admin-routing.test.js passed:', passed, 'assertions');
