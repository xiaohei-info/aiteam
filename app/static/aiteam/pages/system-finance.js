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

  function renderNotImplemented(container) {
    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
      '<h2 class="aiteam-shell__panel-title">财务管理</h2>' +
      '<p class="aiteam-shell__panel-body">平台财务聚合 API 尚未实现（当前返回 501）。此区域已对接 `/api/system-admin/finance/overview`，并预留 `/api/system-admin/finance/reports` 作为导出报表入口。</p>' +
      '<div class="aiteam-shell__meta">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">主读取接口</span><span class="aiteam-shell__meta-value">GET /api/system-admin/finance/overview</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">导出接口</span><span class="aiteam-shell__meta-value">GET /api/system-admin/finance/reports</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">页面职责</span><span class="aiteam-shell__meta-value">平台收入、成本、利润趋势与高消耗企业排行</span></div>' +
      '</div>' +
      '</div>';
  }

  function renderTrend(trendItems) {
    if (!trendItems.length) {
      return '<div class="aiteam-inline-empty">暂无趋势数据</div>';
    }
    var maxRevenue = trendItems.reduce(function (max, item) {
      return Math.max(max, item.revenue);
    }, 0) || 1;
    return '<div class="aiteam-billing__trend">' + trendItems.map(function (item) {
      var height = Math.max(18, Math.round((item.revenue / maxRevenue) * 120));
      return '<div class="aiteam-billing__trend-col">' +
        '<div class="aiteam-billing__trend-bar" style="height:' + height + 'px"></div>' +
        '<span class="aiteam-billing__trend-day">' + item.period + '</span>' +
        '</div>';
    }).join('') + '</div>';
  }

  function renderOverview(container, payload) {
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
        return '<tr><td>' + (index + 1) + '. ' + (item.enterprise_name || item.enterprise_id || item.name || '') + '</td><td>' + money(item.cost || item.total_cost || item.amount) + '</td></tr>';
      }).join('') + '</tbody></table>'
      : '<p class="aiteam-shell__panel-body">暂无高消耗企业排行。</p>';

    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
      '<h2 class="aiteam-shell__panel-title">财务管理</h2>' +
      '<p class="aiteam-shell__panel-body">通过 `/api/system-admin/finance/overview` 消费平台级财务聚合结果；导出能力后续经 `/api/system-admin/finance/reports` 接入。</p>' +
      '<div class="aiteam-billing__actions">' +
      '<button type="button" class="aiteam-pill is-active">本月</button>' +
      '<button type="button" class="aiteam-pill">本年</button>' +
      '<button type="button" class="aiteam-pill">全部</button>' +
      '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-system-finance-export>导出报表</button>' +
      '</div>' +
      '<div class="aiteam-billing__stats">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">总充值金额</span><span class="aiteam-shell__meta-value">' + money(revenue) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">平台成本Token</span><span class="aiteam-shell__meta-value">' + money(cost) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">利润（Token差价）</span><span class="aiteam-shell__meta-value">' + money(profit) + '</span></div>' +
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
  }

  ns.pages.systemFinance = {
    init: function (container) {
      if (!container) return;

      container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载平台财务数据...</p></div>';
      container.lastExportHandler = function () {
        if (window.location && typeof window.location.assign === 'function') {
          window.location.assign(FINANCE_REPORTS_PATH);
        }
        return FINANCE_REPORTS_PATH;
      };

      ns.api.get('/api/system-admin/finance/overview').then(function (result) {
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
        renderOverview(container, result.data);
        bindFinanceActions(container);
      });
    }
  };
}(window.aiteam));
