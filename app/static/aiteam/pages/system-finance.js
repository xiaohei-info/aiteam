window.aiteam = window.aiteam || {};

(function registerSystemFinancePage(ns) {
  ns.pages = ns.pages || {};
  var FINANCE_OVERVIEW_PATH = '/api/system-admin/finance/overview';
  var FINANCE_REPORTS_PATH = '/api/system-admin/finance/reports';

  // 详情表 key → 中文表头。数据里未列出的 key 以原文展示。
  var COLUMN_LABELS = {
    enterprise_name: '企业名称',
    enterprise_id: '企业ID',
    user_name: '操作人',
    amount: '金额',
    revenue: '收入',
    cost: '成本',
    profit: '利润',
    tokens: 'Tokens',
    count: '次数',
    run_count: 'Run 数',
    time: '时间',
    period: '周期',
    description: '说明',
    type: '类型',
    currency: '币种',
  };

  // 以元为单位的金额字段（适用于报表里按元存储的金额）。
  var MONEY_KEYS = {
    amount: 1, revenue: 1, cost: 1, profit: 1,
    total_revenue: 1, total_cost: 1, total_profit: 1,
  };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function money(value) {
    var num = Number(value);
    if (isFinite(num)) return '¥' + num.toLocaleString('en-US');
    if (typeof value === 'string' && value) return value;
    return '—';
  }

  function formatCell(key, value) {
    if (value == null || value === '') return '—';
    if (Object.prototype.hasOwnProperty.call(MONEY_KEYS, key)) {
      return money(value);
    }
    if (key === 'tokens' || key === 'run_count' || key === 'count') {
      var num = Number(value);
      if (isFinite(num)) return num.toLocaleString('en-US');
    }
    return esc(value);
  }

  function normalizeTrend(payload) {
    var trend = Array.isArray(payload && payload.trend) ? payload.trend : [];
    return trend.map(function (item) {
      return {
        period: String(item.period || ''),
        revenue: Number(item.revenue || item.total_revenue || 0),
        cost: Number(item.cost || item.total_cost || 0),
      };
    });
  }

  function profitRate(revenue, cost) {
    var revenueNum = Number(revenue || 0);
    var costNum = Number(cost || 0);
    if (!revenueNum) return '—';
    return ((revenueNum - costNum) / revenueNum * 100).toFixed(1) + '%';
  }

  function renderNotImplemented(container) {
    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
      '<h2 class="aiteam-shell__panel-title">财务管理</h2>' +
      '<p class="aiteam-shell__panel-body">平台财务数据暂时不可用，请稍后刷新重试。</p>' +
      '</div>';
  }

  function periodWindow(key) {
    var now = new Date();
    var year = now.getUTCFullYear();
    var month = now.getUTCMonth();
    if (key === 'this_month') {
      return {
        start: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10),
        end: new Date(Date.UTC(year, month + 1, 1)).toISOString().slice(0, 10),
      };
    }
    if (key === 'this_year') {
      return {
        start: new Date(Date.UTC(year, 0, 1)).toISOString().slice(0, 10),
        end: new Date(Date.UTC(year + 1, 0, 1)).toISOString().slice(0, 10),
      };
    }
    return { start: '', end: '' };
  }

  function buildPeriodQuery(key) {
    var range = periodWindow(key);
    var parts = [];
    if (range.start) parts.push('period_start=' + range.start);
    if (range.end) parts.push('period_end=' + range.end);
    return parts.length ? ('?' + parts.join('&')) : '';
  }

  function normalizeReportRows(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      if (Array.isArray(value.items)) return value.items;
      if (Array.isArray(value.records)) return value.records;
      return [value];
    }
    return [];
  }

  // 通用明细表：从首行 introspect 列，并按需展示中文表头。
  function renderDetailTable(rows, title, emptyText) {
    var data = normalizeReportRows(rows);
    var heading = title || '明细';
    if (!data.length) {
      return '<div class="aiteam-shell__panel">' +
        '<div class="aiteam-billing__section-head">' + esc(heading) + '</div>' +
        '<div class="aiteam-inline-empty">' + esc(emptyText || '当前时间窗口暂无数据') + '</div>' +
        '</div>';
    }
    var seen = {};
    var keys = [];
    data.forEach(function (row) {
      if (!row || typeof row !== 'object') return;
      Object.keys(row).forEach(function (k) {
        if (!Object.prototype.hasOwnProperty.call(seen, k)) {
          seen[k] = 1;
          keys.push(k);
        }
      });
    });
    if (!keys.length) {
      keys = Object.keys(data[0] || {});
    }
    var header = '<thead><tr>' + keys.map(function (k) {
      return '<th>' + esc(COLUMN_LABELS[k] || k) + '</th>';
    }).join('') + '</tr></thead>';
    var body = '<tbody>' + data.map(function (row) {
      var cells = keys.map(function (k) {
        return '<td>' + formatCell(k, row ? row[k] : undefined) + '</td>';
      }).join('');
      return '<tr>' + cells + '</tr>';
    }).join('') + '</tbody>';
    return '<div class="aiteam-shell__panel">' +
      '<div class="aiteam-billing__section-head">' + esc(heading) + '</div>' +
      '<table class="aiteam-table">' + header + body + '</table>' +
      '</div>';
  }

  function exportReportCsv(payload) {
    var rows = Array.isArray(payload && payload.enterprises) ? payload.enterprises : [];
    var header = ['企业ID', '企业名称', 'Tokens', '收入(分)', '成本(分)', '利润(分)', 'Run 数'];
    var lines = [header.join(',')].concat(rows.map(function (item) {
      return [
        item.enterprise_id || '',
        '"' + String(item.enterprise_name || '').replace(/"/g, '""') + '"',
        item.tokens || 0,
        item.revenue_cents || 0,
        item.cost_cents || 0,
        item.profit_cents || 0,
        item.run_count || 0,
      ].join(',');
    }));
    var blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'finance-report.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  function renderTrend(trendItems) {
    if (!trendItems.length) {
      return '<div class="aiteam-inline-empty">暂无趋势数据</div>';
    }
    var maxRevenue = trendItems.reduce(function (max, item) {
      return Math.max(max, item.revenue);
    }, 0) || 1;
    return '<div class="aiteam-billing__trend">' + trendItems.map(function (item) {
      var revenueHeight = Math.max(18, Math.round((item.revenue / maxRevenue) * 120));
      var costHeight = Math.max(12, Math.round((item.cost / maxRevenue) * 120));
      return '<div class="aiteam-billing__trend-col">' +
        '<div class="aiteam-billing__trend-bar" style="height:' + revenueHeight + 'px"></div>' +
        '<div class="aiteam-billing__trend-bar" style="height:' + costHeight + 'px; opacity:.45"></div>' +
        '<span class="aiteam-billing__trend-day">' + item.period + '</span>' +
        '</div>';
    }).join('') + '</div>' +
    '<div class="aiteam-action-row">' +
      '<span class="aiteam-inline-note">充值收入</span>' +
      '<span class="aiteam-inline-note">实际成本</span>' +
    '</div>';
  }

  var REPORT_TABS = [
    { key: 'recharge', field: 'recharge_details', label: '充值明细', empty: '当前时间窗口暂无充值记录' },
    { key: 'consumption', field: 'consumption_details', label: '消耗明细', empty: '当前时间窗口暂无消耗记录' },
    { key: 'profit', field: 'profit_details', label: '利润汇总', empty: '当前时间窗口暂无利润数据' },
  ];

  function renderReportTabs(container, reports, activeKey) {
    if (!container) return;
    var pane = container.querySelector('[data-reports-pane]');
    if (!pane) return;
    pane.innerHTML = REPORT_TABS.map(function (tab) {
      if (tab.key !== activeKey) return '';
      return renderDetailTable(reports ? reports[tab.field] : null, tab.label, tab.empty);
    }).join('');
  }

  function renderOverview(container, payload, activePeriodKey, reports, activeReportKey) {
    if (!payload || (typeof payload !== 'object')) {
      if (ns.states && ns.states.renderEmpty) {
        ns.states.renderEmpty(container, '暂无平台财务汇总');
      }
      return;
    }

    var summary = payload.summary || payload.snapshot || payload;
    var revenue = summary.total_revenue || summary.revenue || summary.income;
    var cost = summary.total_cost || summary.cost;
    var profit = summary.total_profit || summary.profit;
    var payingEnterpriseCount = summary.paying_enterprise_count || summary.enterprise_count || 0;
    var topEnterprises = payload.top_enterprises || payload.top_enterprise_costs || [];
    var trendItems = normalizeTrend(payload);
    var reportSummary = getTotalSummary(reports);

    var topRows = Array.isArray(topEnterprises) && topEnterprises.length
      ? '<table class="aiteam-table"><thead><tr><th>企业</th><th>消耗</th></tr></thead><tbody>' + topEnterprises.map(function (item, index) {
        var enterpriseName = item.enterprise_name || item.enterprise_id || item.name || '';
        return '<tr><td>' + (index + 1) + '. <a href="/system/accounts?enterprise=' + encodeURIComponent(enterpriseName) + '">' + enterpriseName + '</a></td><td>' + money(item.cost || item.total_cost || item.amount) + '</td></tr>';
      }).join('') + '</tbody></table>'
      : '<p class="aiteam-shell__panel-body">暂无高消耗企业排行。</p>';

    var reportMetaCards = !reportSummary
      ? '<p class="aiteam-shell__panel-body">当前时间窗口暂无明细报表数据。</p>'
      : '<div class="aiteam-billing__stats">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">充值笔数</span><span class="aiteam-shell__meta-value">' + (reportSummary.rechargeCount || 0) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">充值总额</span><span class="aiteam-shell__meta-value">' + money(reportSummary.rechargeAmount) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">消耗总额</span><span class="aiteam-shell__meta-value">' + money(reportSummary.consumptionAmount) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">利润总额</span><span class="aiteam-shell__meta-value">' + money(reportSummary.profitAmount) + '</span></div>' +
        '</div>';

    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
      '<h2 class="aiteam-shell__panel-title">财务管理</h2>' +
      '<p class="aiteam-shell__panel-body">查看平台级收入、成本与利润汇总，以及月度趋势、高消耗企业与财务报表明细。</p>' +
      '<div class="aiteam-billing__actions">' +
      [
        { key: 'this_month', label: '本月' },
        { key: 'this_year', label: '本年' },
        { key: 'all', label: '全部' },
      ].map(function (item) {
        var active = item.key === (activePeriodKey || 'all') ? ' is-active' : '';
        return '<button type="button" class="aiteam-pill' + active + '" data-system-finance-period="' + item.key + '">' + item.label + '</button>';
      }).join('') +
      '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-system-finance-export>导出报表</button>' +
      '</div>' +
      '<div class="aiteam-billing__stats">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">总充值金额</span><span class="aiteam-shell__meta-value">' + money(revenue) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">平台成本Token</span><span class="aiteam-shell__meta-value">' + money(cost) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">利润（Token差价）</span><span class="aiteam-shell__meta-value">' + money(profit) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">利润率</span><span class="aiteam-shell__meta-value">' + profitRate(revenue, cost) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">付费企业数</span><span class="aiteam-shell__meta-value">' + payingEnterpriseCount + '</span></div>' +
      '</div>' +
      '<div class="aiteam-shell__two-column">' +
      '<div class="aiteam-shell__panel">' +
      '<div class="aiteam-billing__section-head">月度收入趋势</div>' +
      renderTrend(trendItems) +
      '</div>' +
      '<div class="aiteam-shell__panel">' +
      '<div class="aiteam-billing__section-head">TOP 5 消费企业</div>' +
      topRows +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="aiteam-shell__panel">' +
      '<div class="aiteam-billing__section-head">财务报表明细</div>' +
      '<p class="aiteam-shell__panel-body">查看时间段内的充值明细、消耗明细与利润汇总。指标随上方时间段选择器同步刷新。</p>' +
      reportMetaCards +
      '<div class="aiteam-billing__actions aiteam-billing__tabs">' +
      REPORT_TABS.map(function (tab) {
        var active = tab.key === (activeReportKey || 'recharge') ? ' is-active' : '';
        return '<button type="button" class="aiteam-pill' + active + '" data-reports-tab="' + tab.key + '">' + tab.label + '</button>';
      }).join('') +
      '</div>' +
      '<div data-reports-pane class="aiteam-billing__reports"></div>' +
      '</div>';

    renderReportTabs(container, reports, activeReportKey || 'recharge');
    bindFinanceActions(container);
  }

  // 从报表三张明细表里聚合出顶部汇总卡片的数字（容错：字段不存在就跳过）。
  function getTotalSummary(reports) {
    if (!reports || typeof reports !== 'object') return null;
    var summary = { rechargeCount: 0, rechargeAmount: 0, consumptionAmount: 0, profitAmount: 0 };
    var rechanges = normalizeReportRows(reports.recharge_details);
    var consumptions = normalizeReportRows(reports.consumption_details);
    var profits = normalizeReportRows(reports.profit_details);

    summary.rechargeCount = rechanges.length;
    rechanges.forEach(function (row) {
      summary.revenueAmount = (summary.revenueAmount || 0) + pickAmount(row, ['amount', 'revenue', 'total_revenue']);
      summary.rechargeAmount = (summary.rechargeAmount || 0) + pickAmount(row, ['amount', 'revenue', 'total_revenue']);
    });
    consumptions.forEach(function (row) {
      summary.consumptionAmount = (summary.consumptionAmount || 0) + pickAmount(row, ['amount', 'cost', 'total_cost']);
    });
    profits.forEach(function (row) {
      summary.profitAmount = (summary.profitAmount || 0) + pickAmount(row, ['profit', 'total_profit']);
    });

    if (!rechanges.length && !consumptions.length && !profits.length) {
      return null;
    }
    return summary;
  }

  function pickAmount(row, keys) {
    if (!row) return 0;
    for (var i = 0; i < keys.length; i += 1) {
      var v = row[keys[i]];
      var num = Number(v);
      if (isFinite(num)) return num;
    }
    return 0;
  }

  function bindFinanceActions(container) {
    if (!container || typeof container.querySelector !== 'function') return;
    var exportButton = container.querySelector('[data-system-finance-export]');
    if (exportButton && typeof exportButton.addEventListener === 'function') {
      exportButton.addEventListener('click', function () {
        if (typeof container.lastExportHandler === 'function') {
          container.lastExportHandler();
        }
      });
    }
    var periodButtons = container.querySelectorAll ? container.querySelectorAll('[data-system-finance-period]') : [];
    for (var i = 0; i < periodButtons.length; i += 1) {
      periodButtons[i].addEventListener('click', function () {
        var key = this.getAttribute('data-system-finance-period') || 'this_month';
        if (typeof container.lastPeriodHandler === 'function') {
          container.lastPeriodHandler(key);
        }
      });
    }
    var tabButtons = container.querySelectorAll ? container.querySelectorAll('[data-reports-tab]') : [];
    for (var j = 0; j < tabButtons.length; j += 1) {
      tabButtons[j].addEventListener('click', function () {
        var key = this.getAttribute('data-reports-tab') || 'recharge';
        if (typeof container.lastReportTabHandler === 'function') {
          container.lastReportTabHandler(key);
        }
      });
    }
  }

  ns.pages.systemFinance = {
    init: function (container) {
      if (!container) return;

      var activeState = {
        periodKey: 'all',
        reportKey: 'recharge',
        overview: null,
        reports: null,
      };

      function loadReports(periodKey) {
        if (!periodKey) {
          activeState.reports = null;
          renderOverview(container, activeState.overview, activeState.periodKey, activeState.reports, activeState.reportKey);
          return;
        }
        ns.api.get(FINANCE_REPORTS_PATH + buildPeriodQuery(periodKey)).then(function (result) {
          activeState.reports = result.ok ? (result.data || null) : null;
          renderOverview(container, activeState.overview, activeState.periodKey, activeState.reports, activeState.reportKey);
          bindFinanceActions(container);
        });
      }

      function loadOverview(periodKey) {
        container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载平台财务数据...</p></div>';
        activeState.periodKey = periodKey;
        activeState.overview = null;
        activeState.reports = null;
        ns.api.get(FINANCE_OVERVIEW_PATH + buildPeriodQuery(periodKey)).then(function (result) {
          if (!result.ok) {
            if (result.status === 501) {
              renderNotImplemented(container);
              return;
            }
            if (ns.states && ns.states.handleApiResult) {
              ns.states.handleApiResult(result, container, function () {});
            } else {
              container.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>⚠ 平台财务数据加载失败</p></div>';
            }
            return;
          }
          activeState.overview = result.data || null;
          renderOverview(container, activeState.overview, activeState.periodKey, null, activeState.reportKey);
          loadReports(periodKey);
        });
      }

      container.lastPeriodHandler = function (key) {
        loadOverview(key);
        return key;
      };

      container.lastReportTabHandler = function (key) {
        activeState.reportKey = key;
        // 仅切换已有明细标签页；不重新请求，避免抖动。
        renderOverview(container, activeState.overview, activeState.periodKey, activeState.reports, activeState.reportKey);
        return key;
      };

      container.lastExportHandler = function () {
        var payload = activeState.reports || activeState.overview;
        if (!payload) return FINANCE_REPORTS_PATH;
        exportReportCsv(payload);
        return FINANCE_REPORTS_PATH;
      };

      loadOverview('all');
    }
  };
}(window.aiteam));
