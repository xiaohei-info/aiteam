'use strict';
// Tests for the per-employee history-conversation picker added to the chat
// header. Backend exposes GET /employees/{id}/conversations; the header renders
// a popover so a user can re-open an earlier private conversation.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

const escapeHtml = function (v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
};

function loadPage() {
  const context = {
    window: { aiteam: { util: { escapeHtml }, pages: {} }, addEventListener() {} },
    document: { getElementById() { return null; }, createElement() { return {}; }, addEventListener() {} },
    console,
    setTimeout,
    clearTimeout,
  };
  context.global = context;
  context.globalThis = context;
  context.window.document = context.document;
  const code = fs.readFileSync(path.join(__dirname, 'app-chat.js'), 'utf8');
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.window.aiteam.pages.appChat;
}

test('renderHistoryPanel lists conversations with title/preview/time and marks active', function () {
  const page = loadPage();
  const html = page._renderHistoryPanel([
    { conversation_id: 'conv_new', title: '昨天的方案', last_preview: '继续推进', last_message_at: '2026-06-14 09:00:00+00', navigation_target: '/app/chat/conv_new' },
    { conversation_id: 'conv_old', title: '上周复盘', last_preview: '总结', last_message_at: '2026-06-08 09:00:00+00', navigation_target: '/app/chat/conv_old' },
  ], 'conv_old');

  assert.ok(html.includes('昨天的方案'), 'shows conversation title');
  assert.ok(html.includes('继续推进'), 'shows last preview');
  assert.ok(html.includes('data-history-conv="conv_new"'), 'carries conversation id for click handling');
  assert.ok(html.includes('href="/app/chat/conv_new"'), 'links to the conversation chat path');
  // The currently-open conversation is highlighted.
  const activeMatch = html.match(/aiteam-chatwin__history-item is-active[^>]*data-history-conv="conv_old"/);
  assert.ok(activeMatch, 'active conversation is highlighted');
});

test('renderHistoryPanel shows empty state when no history', function () {
  const page = loadPage();
  const html = page._renderHistoryPanel([], 'conv_x');
  assert.ok(html.includes('暂无历史会话'), 'renders empty state');
});

test('chat header exposes a history button for a bound employee', function () {
  const page = loadPage();
  const html = page._buildChatMainHtml({
    summary: { employee_id: 'emp_1' },
    initial: 'A',
    headerName: 'Analyst',
    defaultStatus: '在线',
    modelLine: '',
  });
  assert.ok(html.includes('data-chat-history'), 'header has the history trigger button');
  assert.ok(html.includes('data-chat-history-panel'), 'header has the history popover container');
});

test('chat header omits history button when no employee is bound', function () {
  const page = loadPage();
  const html = page._buildChatMainHtml({
    summary: {},
    initial: '?',
    headerName: '消息中心',
    defaultStatus: '',
    modelLine: '',
  });
  assert.ok(!html.includes('data-chat-history'), 'no history button without an employee');
});
