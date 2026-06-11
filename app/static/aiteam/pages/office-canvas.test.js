'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

const context = {
  window: { aiteam: {} },
  document: { getElementById() { return null; }, addEventListener() {} },
  console,
  setTimeout,
  clearTimeout,
};
context.global = context;
context.globalThis = context;

const code = fs.readFileSync(path.join(__dirname, 'office-canvas.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const ns = context.window.aiteam;

test('office canvas maps seats to agents', function () {
  assert.ok(ns.officeCanvas, 'officeCanvas should register');
  assert.strictEqual(typeof ns.officeCanvas.mapSeatsToAgents, 'function', 'expected mapSeatsToAgents');

  const agents = ns.officeCanvas.mapSeatsToAgents([
    { employee_id: 'e1', display_name: 'Luna', role_name: '策略分析师', presence: { state: 'working', current_task: '分析', conversation_id: 'c1' } },
  ]);
  assert.strictEqual(agents.length, 1);
  assert.strictEqual(agents[0].name, 'Luna');
  assert.strictEqual(agents[0].role, '策略分析师');
  assert.strictEqual(agents[0].status, 'working');
  assert.strictEqual(agents[0].cur, '分析');
  assert.strictEqual(agents[0].conversation_id, 'c1');
  assert.ok(agents[0].color, 'expected palette color assigned');
});

test('office canvas normalizes presence variants and string presence', function () {
  const agents = ns.officeCanvas.mapSeatsToAgents([
    { employee_id: 'e1', display_name: 'A', presence: { state: 'busy' } },
    { employee_id: 'e2', display_name: 'B', presence: 'offline' },
    { employee_id: 'e3', display_name: 'C', status: 'paused' },
    { employee_id: 'e4', display_name: 'D' },
  ]);
  assert.strictEqual(agents[0].status, 'working', 'busy → working');
  assert.strictEqual(agents[1].status, 'offline', 'string presence offline');
  assert.strictEqual(agents[2].status, 'offline', 'paused → offline');
  assert.strictEqual(agents[3].status, 'idle', 'default → idle');
  assert.strictEqual(agents[3].cur, '等待任务', 'default current task');
});

test('office canvas handles empty/missing seats', function () {
  assert.strictEqual(ns.officeCanvas.mapSeatsToAgents([]).length, 0);
  assert.strictEqual(ns.officeCanvas.mapSeatsToAgents().length, 0);
});
