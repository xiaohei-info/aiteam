'use strict';
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

// A permissive fake DOM node: every query returns another fake node and every
// method is a no-op, so renderGroup's binding pass never crashes in the VM.
function makeNode() {
  const node = {
    innerHTML: '',
    value: '',
    hidden: false,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
    scrollIntoView() {},
    querySelector() { return makeNode(); },
    querySelectorAll() { return []; },
  };
  return node;
}

function buildContext(testState) {
  const context = {
    window: {
      location: { pathname: '/app/group/conv_team', search: '' },
      history: { replaceState() {} },
      localStorage: { getItem() { return null; }, setItem() {} },
      aiteam: { util: { escapeHtml } },
    },
    document: { getElementById() { return null; }, createElement() { return makeNode(); } },
    console,
    setTimeout,
    clearTimeout,
  };
  context.window.aiteam.states = {
    renderLoading(container, message) { testState.loadingCalls.push(message); container.innerHTML = '<div>loading</div>'; },
    handleApiResult() { throw new Error('handleApiResult should not be called in success path'); },
  };
  context.window.aiteam.api = {
    getGroupConversation(id) {
      testState.getCalls.push(id);
      return Promise.resolve({ ok: true, data: { conversation_id: 'conv_team', title: '增长突击队', members: [], member_count: 2 } });
    },
    getWorkbench() {
      return Promise.resolve({
        ok: true,
        data: {
          employees: [],
          groups: [{ conversation_id: 'conv_team', title: '增长突击队', member_count: 2, unread_count: 4 }],
        },
      });
    },
    updateWorkbenchState(body) { testState.updateCalls.push(body); return Promise.resolve({ ok: true, data: {} }); },
  };
  context.global = context;
  context.globalThis = context;
  context.window.document = context.document;
  return context;
}

const code = fs.readFileSync(path.join(__dirname, 'app-group.js'), 'utf8');

test('opening a group conversation marks its unread count as read in workbench state', async function () {
  const testState = { getCalls: [], updateCalls: [], loadingCalls: [] };
  const context = buildContext(testState);
  vm.createContext(context);
  vm.runInContext(code, context);

  const page = context.window.aiteam.pages.appGroup;
  assert.ok(page && typeof page.init === 'function', 'appGroup page should expose init');

  const container = makeNode();
  page.init(container, { pathname: '/app/group/conv_team' });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });

  assert.ok(testState.getCalls.indexOf('conv_team') !== -1, 'group init should fetch the conversation');
  assert.strictEqual(testState.updateCalls.length, 1, 'group init should mark the opened conversation as read once');
  assert.strictEqual(testState.updateCalls[0].conversation_id, 'conv_team', 'group init should mark the opened group conversation id as read');
  assert.strictEqual(testState.updateCalls[0].mark_read, true, 'group init should set mark_read=true');
});

test('opening a group conversation with no unread does not call updateWorkbenchState', async function () {
  const testState = { getCalls: [], updateCalls: [], loadingCalls: [] };
  const context = buildContext(testState);
  context.window.aiteam.api.getWorkbench = function () {
    return Promise.resolve({
      ok: true,
      data: { employees: [], groups: [{ conversation_id: 'conv_team', title: '增长突击队', member_count: 2, unread_count: 0 }] },
    });
  };
  vm.createContext(context);
  vm.runInContext(code, context);

  const page = context.window.aiteam.pages.appGroup;
  const container = makeNode();
  page.init(container, { pathname: '/app/group/conv_team' });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });

  assert.strictEqual(testState.updateCalls.length, 0, 'no unread means no mark_read write');
});

test('system Planner is labeled and excluded from removable members', function () {
  const testState = { getCalls: [], updateCalls: [], loadingCalls: [] };
  const context = buildContext(testState);
  vm.createContext(context);
  vm.runInContext(code, context);

  const page = context.window.aiteam.pages.appGroup;
  assert.ok(page._renderMemberCard, 'appGroup should expose renderMemberCard test helper');
  assert.ok(page._removableMemberOptions, 'appGroup should expose removableMemberOptions test helper');

  const planner = {
    member_id: 'mem_planner',
    employee_id: 'emp_sys_planner',
    display_name: '协作主持人',
    role_name: 'orchestrator',
    is_system_planner: true,
  };
  const member = {
    member_id: 'mem_worker',
    employee_id: 'emp_worker',
    display_name: '分析师',
    role_name: '研究员',
    is_system_planner: false,
  };

  const plannerHtml = page._renderMemberCard(planner);
  assert.ok(plannerHtml.indexOf('主持') !== -1, 'system Planner member card should show host badge');
  assert.strictEqual(plannerHtml.indexOf('/admin/employees/emp_sys_planner'), -1, 'system Planner should not link to employee detail');

  const options = page._removableMemberOptions([planner, member]);
  assert.strictEqual(options.indexOf('mem_planner'), -1, 'system Planner should not appear in remove select');
  assert.ok(options.indexOf('mem_worker') !== -1, 'normal members should remain removable');
});

test('bare /app/group renders the group list landing (not a full-page create form)', async function () {
  const testState = { getCalls: [], updateCalls: [], loadingCalls: [] };
  const context = buildContext(testState);
  context.window.location.pathname = '/app/group';
  vm.createContext(context);
  vm.runInContext(code, context);

  const page = context.window.aiteam.pages.appGroup;
  const container = makeNode();
  page.init(container, { pathname: '/app/group' });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });

  // Landing = left list + empty main, with a "+" that opens the create modal.
  assert.ok(container.innerHTML.indexOf('data-group-create-open') !== -1, 'landing should expose the create-modal "+" trigger');
  assert.ok(container.innerHTML.indexOf('增长突击队') !== -1, 'landing should render the group conversation list from workbench');
  // It must NOT be the old full-page launcher form.
  assert.strictEqual(container.innerHTML.indexOf('data-group-create-launch'), -1, 'landing should not embed the full create form');
  assert.strictEqual(testState.getCalls.length, 0, 'landing should not fetch any group conversation detail');
});

test('create-group modal renders the collaboration mode selector and forwards payload', async function () {
  const testState = { getCalls: [], updateCalls: [], loadingCalls: [], createCalls: [], createdWith: [] };
  const context = buildContext(testState);
  context.window.aiteam.api.getEmployees = function () {
    return Promise.resolve({ ok: true, data: { items: [
      { employee_id: 'emp_a', display_name: '员工A', role_name: '研究员' },
      { employee_id: 'emp_b', display_name: '员工B', role_name: '文案' },
    ] } });
  };
  context.window.aiteam.api.createGroupConversation = function (payload) {
    testState.createCalls.push(payload);
    return Promise.resolve({ ok: true, data: { conversation_id: 'conv_new' } });
  };
  vm.createContext(context);
  vm.runInContext(code, context);

  const page = context.window.aiteam.pages.appGroup;
  assert.ok(typeof page._renderGroupCreateModal === 'function', 'appGroup should expose the create-modal renderer');

  const host = makeNode();
  page._renderGroupCreateModal(host, { onCreated: function (id) { testState.createdWith.push(id); } });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });

  assert.ok(host.innerHTML.indexOf('aiteam-modal') !== -1, 'create flow should render as a modal, not a page');
  assert.ok(host.innerHTML.indexOf('自由讨论') !== -1, 'modal should offer 自由讨论 option');
  assert.ok(host.innerHTML.indexOf('规则编排') !== -1, 'modal should offer 规则编排 option');
  assert.ok(host.innerHTML.indexOf('data-group-create-mode="free"') !== -1, 'modal should render the free-mode radio');
  assert.ok(host.innerHTML.indexOf('data-group-create-mode="orchestrated"') !== -1, 'modal should render the orchestrated-mode radio');

  await host.lastCreateGroupHandler({
    title: '编排群',
    member_employee_ids: ['emp_a', 'emp_b'],
    collaboration_mode: 'orchestrated',
    orchestration_brief: '先调研再撰写',
  });
  assert.strictEqual(testState.createCalls.length, 1, 'create handler should call createGroupConversation once');
  assert.strictEqual(testState.createCalls[0].collaboration_mode, 'orchestrated', 'payload should carry collaboration_mode');
  assert.strictEqual(testState.createCalls[0].orchestration_brief, '先调研再撰写', 'payload should carry orchestration_brief');
  assert.deepStrictEqual(testState.createdWith, ['conv_new'], 'onCreated should receive the new conversation id');
});

test('group settings inline edit forwards rename + collaboration mode to updateGroupConversation', function () {
  const testState = { getCalls: [], updateCalls: [], loadingCalls: [], patchCalls: [] };
  const context = buildContext(testState);
  context.window.aiteam.api.updateGroupConversation = function (conversationId, body) {
    testState.patchCalls.push({ conversationId: conversationId, body: body });
    return Promise.resolve({ ok: true, data: Object.assign({ conversation_id: conversationId }, body) });
  };
  vm.createContext(context);
  vm.runInContext(code, context);

  const page = context.window.aiteam.pages.appGroup;
  const container = makeNode();
  page.render(container, {
    conversation_id: 'conv_team',
    title: '旧名',
    members: [],
    member_count: 2,
    collaboration_mode: 'free',
    orchestration_brief: '',
  });

  assert.ok(typeof container.lastUpdateGroupHandler === 'function', 'detail view should expose the settings update handler');
  container.lastUpdateGroupHandler({
    title: '新名',
    collaboration_mode: 'orchestrated',
    orchestration_brief: '先A后B',
  });

  assert.strictEqual(testState.patchCalls.length, 1, 'save should call updateGroupConversation once');
  assert.strictEqual(testState.patchCalls[0].conversationId, 'conv_team', 'should target the open conversation');
  assert.strictEqual(testState.patchCalls[0].body.title, '新名', 'should forward the new title');
  assert.strictEqual(testState.patchCalls[0].body.collaboration_mode, 'orchestrated', 'should forward the new mode');
  assert.strictEqual(testState.patchCalls[0].body.orchestration_brief, '先A后B', 'should forward the brief');
});
