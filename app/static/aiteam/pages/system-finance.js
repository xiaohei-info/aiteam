window.aiteam = window.aiteam || {};

(function registerSystemFinancePage(ns) {
  ns.pages = ns.pages || {};
  var FINANCE_REPORTS_PATH = '/api/system-admin/finance/reports';

  function money(value) {
    var num = Number(value);
    if (isFinite(num)) return '¥' + num.toLocaleString('en-US');
    if (typeof value === 'string' && value) return value;
    return '—';
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

  function renderOverview(container, payload, activePeriodKey) {
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

    var topRows = Array.isArray(topEnterprises) && topEnterprises.length
      ? '<table class="aiteam-table"><thead><tr><th>企业</th><th>消耗</th></tr></thead><tbody>' + topEnterprises.map(function (item, index) {
        var enterpriseName = item.enterprise_name || item.enterprise_id || item.name || '';
        return '<tr><td>' + (index + 1) + '. <a href="/system/accounts?enterprise=' + encodeURIComponent(enterpriseName) + '">' + enterpriseName + '</a></td><td>' + money(item.cost || item.total_cost || item.amount) + '</td></tr>';
      }).join('') + '</tbody></table>'
      : '<p class="aiteam-shell__panel-body">暂无高消耗企业排行。</p>';

    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
      '<h2 class="aiteam-shell__panel-title">财务管理</h2>' +
      '<p class="aiteam-shell__panel-body">查看平台级收入、成本与利润汇总，以及月度趋势与高消耗企业排行。</p>' +
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
      '</div>';
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
  }

  ns.pages.systemFinance = {
    init: function (container) {
      if (!container) return;

      function buildPeriodQuery(key) {
        var range = periodWindow(key);
        var parts = [];
        if (range.start) parts.push('period_start=' + range.start);
        if (range.end) parts.push('period_end=' + range.end);
        return parts.length ? ('?' + parts.join('&')) : '';
      }

      function loadOverview(periodKey) {
        container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载平台财务数据...</p></div>';
        ns.api.get('/api/system-admin/finance/overview' + buildPeriodQuery(periodKey)).then(function (result) {
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
          renderOverview(container, result.data, periodKey);
          bindFinanceActions(container);
        });
      }

      container.lastPeriodHandler = function (key) {
        loadOverview(key);
        return key;
      };

      container.lastExportHandler = function () {
        ns.api.get(FINANCE_REPORTS_PATH).then(function (result) {
          if (result.ok) {
            exportReportCsv(result.data);
          }
        });
        return FINANCE_REPORTS_PATH;
      };

      loadOverview('all');
    }
  };
}(window.aiteam));
