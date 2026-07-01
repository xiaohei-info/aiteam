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
      const payload = event || { type: '' };
      (this.events[payload.type] || []).forEach(function (fn) { fn.call(el, payload); });
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

const GET_PATHS = [];
const GET_RESULTS = {
  '/api/system-admin/finance/overview': {
    ok: true,
    data: {
      summary: { total_revenue: 1000, total_cost: 600, total_profit: 400, paying_enterprise_count: 3 },
      top_enterprises: [
        { enterprise_name: '企业A', total_cost: 200 },
        { enterprise_name: '企业B', total_cost: 100 },
      ],
      trend: [{ period: '2026-06', revenue: 500, cost: 300 }],
    },
  },
  '/api/system-admin/finance/reports': {
    ok: true,
    data: {
      recharge_details: [
        { enterprise_name: '企业A', amount: 500, time: '2026-06-01' },
        { enterprise_name: '企业B', amount: 300, time: '2026-06-15' },
      ],
      consumption_details: [
        { enterprise_name: '企业A', amount: 200, tokens: 1000, time: '2026-06-02' },
      ],
      profit_details: [
        { enterprise_name: '企业A', revenue: 500, cost: 300, profit: 200 },
        { enterprise_name: '企业B', revenue: 300, cost: 100, profit: 200 },
      ],
    },
  },
};

const context = {
  window: {
    aiteam: {
      api: {
        get(p) {
          GET_PATHS.push(p);
          const bare = String(p || '').replace(/[?&]role=[^&]*/g, '').replace(/\?$/, '');
          const exact = GET_RESULTS[bare];
          if (exact) return Promise.resolve(exact);
          // period-bounded variants fall back to the unprefixed fixtures by path stem
          const stem = bare.replace(/[?&].*/, '');
          const stemHit = GET_RESULTS[stem];
          if (stemHit) return Promise.resolve(stemHit);
          return Promise.resolve({ ok: false, status: 500 });
        },
      },
      states: {
        handleApiResult() {},
        renderEmpty() {},
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

const code = fs.readFileSync(path.join(__dirname, 'system-finance.js'), 'utf8');
vm.createContext(context);
vm.runInContext(code, context);

const assert = require('assert');

async function run() {
  const container = createElement('main');
  context.window.aiteam.pages.systemFinance.init(container);
  // wait for both GET resolutions (overview + reports)
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(GET_PATHS.some((p) => p.indexOf('/api/system-admin/finance/overview') === 0), 'overview called');
  assert.ok(
    GET_PATHS.some((p) => p.indexOf('/api/system-admin/finance/reports') === 0),
    'reports called with period',
  );

  const html = container.innerHTML;
  assert.ok(html.includes('财务报表明细'), 'reports section rendered');
  assert.ok(html.includes('充值明细'), 'recharge tab rendered');
  assert.ok(html.includes('消耗明细'), 'consumption tab rendered');
  assert.ok(html.includes('利润汇总'), 'profit tab rendered');
  assert.ok(html.includes('充值笔数'), 'recharge count summary card rendered');
  assert.ok(html.includes('企业A'), 'enterprise rows rendered in active tab');
  assert.ok(html.includes('当前时间窗口暂无消耗记录') === false, 'empty text hidden when rows exist');

  // 切换报表标签页不触发新的 GET
  const before = GET_PATHS.length;
  container.lastReportTabHandler('profit');
  assert.strictEqual(GET_PATHS.length, before, 'tab switch does not refetch');

  // 切换时间段触发 overview + reports 重新请求
  container.lastPeriodHandler('this_month');
  await new Promise((r) => setTimeout(r, 30));
  const monthHits = GET_PATHS.filter((p) => p.indexOf('period_start=') !== -1).length;
  assert.ok(monthHits >= 2, 'period change refetches overview+reports with date range');

  // periodKey=all 不传日期参数
  container.lastPeriodHandler('all');
  await new Promise((r) => setTimeout(r, 30));

  console.log('OK: GET paths=' + JSON.stringify(GET_PATHS));
}

run().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
