window.aiteam = window.aiteam || {};

(function registerSystemFinancePage(ns) {
  ns.pages = ns.pages || {};

  function money(value) {
    if (typeof value === 'number') {
      return '¥' + value.toFixed(2);
    }
    if (typeof value === 'string' && value) {
      return value;
    }
    return '—';
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
    var topEnterprises = payload.top_enterprises || payload.top_enterprise_costs || [];
    var trend = payload.trend || payload.finance_trend || [];
    var trendLabel = Array.isArray(trend) ? (trend.length ? String(trend.length) + ' 个周期' : '暂无趋势数据') : '暂无趋势数据';
    var topRows = Array.isArray(topEnterprises) && topEnterprises.length
      ? '<table class="aiteam-table"><thead><tr><th>企业</th><th>消耗</th></tr></thead><tbody>' + topEnterprises.map(function (item) {
        return '<tr><td>' + (item.enterprise_name || item.enterprise_id || item.name || '') + '</td><td>' + money(item.cost || item.total_cost || item.amount) + '</td></tr>';
      }).join('') + '</tbody></table>'
      : '<p class="aiteam-shell__panel-body">暂无高消耗企业排行。</p>';

    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
      '<h2 class="aiteam-shell__panel-title">财务管理</h2>' +
      '<p class="aiteam-shell__panel-body">通过 `/api/system-admin/finance/overview` 消费平台级财务聚合结果；导出能力后续经 `/api/system-admin/finance/reports` 接入。</p>' +
      '<div class="aiteam-shell__meta">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">平台收入</span><span class="aiteam-shell__meta-value">' + money(revenue) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">平台成本</span><span class="aiteam-shell__meta-value">' + money(cost) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">平台利润</span><span class="aiteam-shell__meta-value">' + money(profit) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">趋势覆盖</span><span class="aiteam-shell__meta-value">' + trendLabel + '</span></div>' +
      '</div>' +
      topRows +
      '</div>';
  }

  ns.pages.systemFinance = {
    init: function (container) {
      if (!container) return;

      container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载平台财务数据...</p></div>';

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
      });
    }
  };
}(window.aiteam));
