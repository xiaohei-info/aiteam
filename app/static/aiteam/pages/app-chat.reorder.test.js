'use strict';
// Regression tests for in-place "rise to top" of the agent the user just
// messaged — moveAgentToTop must lift the matching anchor to the top of its own
// section without rebuilding the list (search text + scroll position survive).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

// ── A tiny order-aware fake DOM ────────────────────────────────────────────
// Models exactly the surface moveAgentToTop touches: ordered children,
// previousElementSibling, firstChild/nextSibling, insertBefore, classList,
// and attribute-based querySelector.
function makeEl(tag, attrs, className) {
  return {
    tag: tag,
    parentNode: null,
    _attrs: attrs || {},
    classList: {
      _set: new Set((className || '').split(' ').filter(Boolean)),
      contains(c) { return this._set.has(c); },
    },
    getAttribute(k) { return this._attrs[k] !== undefined ? this._attrs[k] : null; },
  };
}

function makeList(children) {
  const node = {
    children: [],
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      const from = this.children.indexOf(child);
      if (from !== -1) this.children.splice(from, 1);
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at === -1) this.children.push(child);
      else this.children.splice(at, 0, child);
      child.parentNode = this;
      return child;
    },
  };
  Object.defineProperty(node, 'firstChild', { get() { return this.children[0] || null; } });
  (children || []).forEach(function (c) { node.appendChild(c); });
  // Link sibling getters now that order is established.
  node.children.forEach(function (c) {
    Object.defineProperty(c, 'previousElementSibling', {
      configurable: true,
      get() { const i = node.children.indexOf(this); return i > 0 ? node.children[i - 1] : null; },
    });
    Object.defineProperty(c, 'nextSibling', {
      configurable: true,
      get() { const i = node.children.indexOf(this); return i >= 0 && i < node.children.length - 1 ? node.children[i + 1] : null; },
    });
  });
  return node;
}

function label(text) { return makeEl('div', { text: text }, 'aiteam-chat__group-label'); }
function agent(empId) { return makeEl('a', { 'data-chat-agent': empId }, 'aiteam-chat__agent'); }

// A container whose querySelector resolves the data-chat-agent attribute match
// against a backing list, mirroring the real DOM lookup moveAgentToTop uses.
function makeContainer(list) {
  return {
    querySelector(sel) {
      const m = /data-chat-agent="([^"]+)"/.exec(sel);
      if (!m) return null;
      return list.children.find(function (c) { return c.getAttribute('data-chat-agent') === m[1]; }) || null;
    },
  };
}

function ids(list) {
  return list.children
    .filter(function (c) { return c.tag === 'a'; })
    .map(function (c) { return c.getAttribute('data-chat-agent'); });
}

// ── Load the module under test in an isolated VM context ────────────────────
const code = fs.readFileSync(path.join(__dirname, 'app-chat.js'), 'utf8');
function loadPage() {
  const ctx = { window: { aiteam: {} }, console, setTimeout, clearTimeout };
  ctx.global = ctx; ctx.globalThis = ctx; ctx.document = { getElementById() { return null; } };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.window.aiteam.pages.appChat;
}

test('messaged agent rises to the top of its section', function () {
  const page = loadPage();
  const list = makeList([
    label('🤖 其他智能体'),
    agent('emp_a'), agent('emp_b'), agent('emp_c'),
  ]);
  page._moveAgentToTop(makeContainer(list), 'emp_c');
  assert.deepStrictEqual(ids(list), ['emp_c', 'emp_a', 'emp_b']);
});

test('agent never jumps across sections — only to the top of its own', function () {
  const page = loadPage();
  const list = makeList([
    label('📌 置顶'), agent('emp_pin'),
    label('🤖 其他智能体'), agent('emp_a'), agent('emp_b'),
  ]);
  // Message emp_b: it should land right after the 其他智能体 label, above emp_a,
  // but must stay below the pinned section.
  page._moveAgentToTop(makeContainer(list), 'emp_b');
  assert.deepStrictEqual(ids(list), ['emp_pin', 'emp_b', 'emp_a']);
});

test('messaging the already-top agent is a no-op', function () {
  const page = loadPage();
  const list = makeList([label('🤖 其他智能体'), agent('emp_a'), agent('emp_b')]);
  page._moveAgentToTop(makeContainer(list), 'emp_a');
  assert.deepStrictEqual(ids(list), ['emp_a', 'emp_b']);
});

test('unknown employee id is ignored', function () {
  const page = loadPage();
  const list = makeList([label('🤖 其他智能体'), agent('emp_a'), agent('emp_b')]);
  page._moveAgentToTop(makeContainer(list), 'emp_missing');
  assert.deepStrictEqual(ids(list), ['emp_a', 'emp_b']);
});
