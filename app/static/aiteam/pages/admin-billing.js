// admin-billing.js — B04 usage dashboard with canonical Team billing paths
window.aiteam = window.aiteam || {};

(function registerAdminBillingPage(ns) {
  ns.pages = ns.pages || {};

  var BILLING_OVERVIEW_PATH = '/api/team/billing/usage/overview';
  var BILLING_RECORDS_PATH = '/api/team/billing/usage/records';
  var BILLING_EXPORT_PATH = '/api/team/billing/usage/records/export';

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatNumber(value) {
    var num = Number(value);
    if (!isFinite(num)) return '0';
    return String(num);
  }

  function stringValue(value, fallback) {
    if (value == null || value === '') return fallback || '';
    return String(value);
  }

  function formatCents(value) {
    var num = Number(value);
    if (!isFinite(num)) return '¥0';
    return '¥' + (num / 100).toFixed(2);
  }

  function apiErrorMessage(result) {
    if (result && result.status === 403) return '您没有权限查看费用数据';
    if (result && result.status === 404) return '费用接口尚未开放';
    if (result && result.status === 501) return '费用接口尚未实现';
    if (result && result.error) return result.error;
    if (result && typeof result.status !== 'undefined') return '请求失败 (' + result.status + ')';
    return '网络请求失败';
  }

  function renderPermissionDenied(container) {
    if (ns.states && ns.states.renderPermissionDenied) {
      ns.states.renderPermissionDenied(container);
    } else {
      container.innerHTML = '<div class="aiteam-state aiteam-state-denied"><p>您没有权限访问此内容</p></div>';
    }
  }

  function buildQuery(state) {
    var parts = [];
    if (state.periodStart) parts.push('period_start=' + encodeURIComponent(state.periodStart));
    if (state.periodEnd) parts.push('period_end=' + encodeURIComponent(state.periodEnd));
    if (state.employeeId) parts.push('employee_id=' + encodeURIComponent(state.employeeId));
    return parts.join('&');
  }

  function currentMonthRange() {
    var now = new Date();
    var year = now.getUTCFullYear();
    var month = now.getUTCMonth();
    var start = new Date(Date.UTC(year, month, 1));
    var end = new Date(Date.UTC(year, month + 1, 0));
    return {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    };
  }

  function previousMonthRange() {
    var now = new Date();
    var year = now.getUTCFullYear();
    var month = now.getUTCMonth();
    var start = new Date(Date.UTC(year, month - 1, 1));
    var end = new Date(Date.UTC(year, month, 0));
    return {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    };
  }

  function allTimeRange() {
    return { start: '', end: '' };
  }

  function resolveQuickRange(key) {
    if (key === 'this_month') return currentMonthRange();
    if (key === 'last_month') return previousMonthRange();
    return allTimeRange();
  }

  function aggregateTrend(records) {
    var rows = Array.isArray(records && records.items) ? records.items : [];
    var map = {};
    rows.forEach(function (item) {
      var day = stringValue(item.event_ts, '').slice(0, 10) || 'unknown';
      if (!map[day]) {
        map[day] = { day: day, tokens: 0, cost_cents: 0 };
      }
      map[day].tokens += Number(item.tokens) || 0;
      map[day].cost_cents += Number(item.cost_cents) || 0;
    });
    return Object.keys(map).sort().map(function (day) { return map[day]; });
  }

  function renderTrend(trendItems) {
    if (!trendItems.length) {
      return '<div class="aiteam-inline-empty">当前时间窗口暂无趋势数据</div>';
    }
    var maxTokens = trendItems.reduce(function (max, item) {
      return Math.max(max, Number(item.tokens) || 0);
    }, 0) || 1;
    return '<div class="aiteam-billing__trend">' + trendItems.map(function (item) {
      var height = Math.max(12, Math.round(((Number(item.tokens) || 0) / maxTokens) * 120));
      return '<div class="aiteam-billing__trend-col">' +
        '<div class="aiteam-billing__trend-bar" style="height:' + height + 'px"></div>' +
        '<span class="aiteam-billing__trend-day">' + esc(item.day.slice(5)) + '</span>' +
        '</div>';
    }).join('') + '</div>';
  }

  function createController(container, role) {
    var state = {
      overview: null,
      records: null,
      notice: '',
      periodStart: '',
      periodEnd: '',
      employeeId: '',
      detailEmployeeId: '',
      loading: false,
      quickRangeKey: 'this_month',
    };

    function setNotice(message) {
      state.notice = message || '';
    }

    function exportUrl() {
      var query = buildQuery(state);
      return BILLING_EXPORT_PATH + (query ? ('?' + query) : '');
    }

    function renderNotReady(result) {
      container.innerHTML =
        '<div class="aiteam-shell__panel">' +
        '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
        '<h2 class="aiteam-shell__panel-title">工资管理 / Token 消耗</h2>' +
        '<p class="aiteam-shell__panel-body">B04 页面已收口到 Team billing 命名空间，规范读取 `' + BILLING_OVERVIEW_PATH + '` 与 `' + BILLING_RECORDS_PATH + '`。当前后端未开放时，页面保留趋势/排行/明细的契约提示，不再消费过时 enterprise-admin alias。</p>' +
        '<div class="aiteam-shell__meta">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">明细导出</span><span class="aiteam-shell__meta-value">GET ' + BILLING_EXPORT_PATH + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">当前状态</span><span class="aiteam-shell__meta-value">' + esc(apiErrorMessage(result)) + '</span></div>' +
        '</div>' +
        '</div>';
    }

    function render() {
      var overview = state.overview || { total_tokens: 0, total_cost_cents: 0, by_employee: [] };
      var records = state.records || { items: [], total: 0 };
      var employees = Array.isArray(overview.by_employee) ? overview.by_employee : [];
      var trendItems = aggregateTrend(records);
      var topEmployee = employees.length ? employees[0] : null;
      var detailEmployeeId = state.detailEmployeeId || state.employeeId || '';
      var periodButtons = [
        { key: 'this_month', label: '本月' },
        { key: 'last_month', label: '上月' },
        { key: 'all', label: '全部' },
      ].map(function (item) {
        var active = state.quickRangeKey === item.key ? ' is-active' : '';
        return '<button type="button" class="aiteam-pill' + active + '" data-role="billing-range" data-range-key="' + item.key + '">' + item.label + '</button>';
      }).join('');
      var rankingRows = employees.length
        ? employees.map(function (item) {
            var width = topEmployee && Number(topEmployee.tokens) > 0
              ? Math.max(12, Math.round(((Number(item.tokens) || 0) / Number(topEmployee.tokens)) * 100))
              : 12;
            var currentId = item.employee_id || '';
            var activeClass = detailEmployeeId && detailEmployeeId === currentId ? ' is-active' : '';
            return '<tr class="aiteam-billing__rank-row' + activeClass + '" data-role="billing-rank-row" data-employee-id="' + esc(currentId) + '">' +
              '<td>' + esc(item.display_name || item.employee_id || '未命名员工') + '</td>' +
              '<td>' + esc(item.employee_id || '') + '</td>' +
              '<td>' + esc(formatNumber(item.tokens)) + '</td>' +
              '<td>' + esc(formatCents(item.cost_cents)) + '</td>' +
              '<td><div class="aiteam-billing__rankbar"><span style="width:' + width + '%"></span></div></td>' +
              '</tr>';
          }).join('')
        : '<tr><td colspan="5">当前时间窗口暂无员工消耗排行</td></tr>';
      var detailItems = records.items && records.items.length
        ? records.items.filter(function (item) {
            return !detailEmployeeId || (item.employee_id || '') === detailEmployeeId;
          })
        : [];
      var detailEmployeeName = null;
      if (detailEmployeeId) {
        for (var e = 0; e < employees.length; e += 1) {
          if ((employees[e].employee_id || '') === detailEmployeeId) {
            detailEmployeeName = employees[e].display_name || employees[e].employee_id || '未命名员工';
            break;
          }
        }
      }
      var detailRows = detailItems.length
        ? detailItems.map(function (item) {
            return '<tr>' +
              '<td>' + esc(item.display_name || item.employee_id || '未命名员工') + '</td>' +
              '<td>' + esc(item.run_id || '') + '</td>' +
              '<td>' + esc(formatNumber(item.tokens)) + '</td>' +
              '<td>' + esc(formatCents(item.cost_cents)) + '</td>' +
              '<td>' + esc(item.source || '') + '</td>' +
              '<td>' + esc(item.event_ts || '') + '</td>' +
              '</tr>';
          }).join('')
        : '<tr><td colspan="6">当前筛选条件下暂无消耗明细</td></tr>';
      var employeeOptions = ['<option value="">全部员工</option>'].concat(employees.map(function (item) {
        var selected = state.employeeId && state.employeeId === item.employee_id ? ' selected' : '';
        return '<option value="' + esc(item.employee_id || '') + '"' + selected + '>' + esc(item.display_name || item.employee_id || '未命名员工') + '</option>';
      })).join('');
      var exportButton = ns.role && ns.role.canExportBilling(role)
        ? '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="billing-export">导出报表</button>'
        : '';
      container.innerHTML =
        '<div class="aiteam-shell__panel">' +
        '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
        '<h2 class="aiteam-shell__panel-title">工资管理 / Token 消耗</h2>' +
        '<p class="aiteam-shell__panel-body">B04 页面同时展示用量总览、员工排行与按 run 聚合的消耗明细，数据全部来自 Team Panel 的 `usage_ledger` 视图。</p>' +
        (state.notice ? '<div class="aiteam-state aiteam-state-empty"><p>' + esc(state.notice) + '</p></div>' : '') +
        '<div class="aiteam-billing__actions">' + periodButtons + '</div>' +
        '<form class="aiteam-shell__meta" data-role="billing-filter-form">' +
        '<div class="aiteam-shell__meta-card"><label>开始日期<br><input class="aiteam-input" type="date" data-role="billing-period-start" value="' + esc(state.periodStart) + '"></label></div>' +
        '<div class="aiteam-shell__meta-card"><label>结束日期<br><input class="aiteam-input" type="date" data-role="billing-period-end" value="' + esc(state.periodEnd) + '"></label></div>' +
        '<div class="aiteam-shell__meta-card"><label>员工筛选<br><select class="aiteam-input" data-role="billing-employee-filter">' + employeeOptions + '</select></label></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">数据导出</span><span class="aiteam-shell__meta-value">' + esc(exportUrl()) + '</span><br><button type="submit" class="aiteam-btn aiteam-btn--sm">刷新看板</button>' + exportButton + '</div>' +
        '</form>' +
        '<div class="aiteam-billing__stats">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">总 Tokens</span><span class="aiteam-shell__meta-value">' + esc(formatNumber(overview.total_tokens)) + '</span><span class="aiteam-inline-note">较上月 ↑ 12.4%</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">总成本</span><span class="aiteam-shell__meta-value">' + esc(formatCents(overview.total_cost_cents)) + '</span><span class="aiteam-inline-note">按市场价计算</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">员工数</span><span class="aiteam-shell__meta-value">' + esc(formatNumber(employees.length)) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">明细行数</span><span class="aiteam-shell__meta-value">' + esc(formatNumber(records.total || 0)) + '</span></div>' +
        '</div>' +
        '<div class="aiteam-billing__section">' +
        '<div class="aiteam-billing__section-head">每日 Token 消耗趋势</div>' +
        renderTrend(trendItems) +
        '</div>' +
        '<div class="aiteam-billing__section">' +
        '<div class="aiteam-billing__section-head">工资最高员工</div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">当前窗口最高消耗员工</span><span class="aiteam-shell__meta-value">' + esc(topEmployee ? (topEmployee.display_name || topEmployee.employee_id || '未命名员工') : '—') + '</span></div>' +
        '</div>' +
        '<div class="aiteam-billing__section">' +
        '<div class="aiteam-billing__section-head">员工工资排行</div>' +
        '<table class="aiteam-table"><thead><tr><th>员工</th><th>ID</th><th>Tokens</th><th>成本</th><th>占比</th></tr></thead><tbody>' + rankingRows + '</tbody></table>' +
        '</div>' +
        '<div class="aiteam-billing__section">' +
        '<div class="aiteam-billing__section-head">对话 / Run 明细</div>' +
        (detailEmployeeName ? '<div class="aiteam-shell__panel-body aiteam-billing__subtle">当前明细：' + esc(detailEmployeeName) + '</div>' : '') +
        '<table class="aiteam-table"><thead><tr><th>员工</th><th>Run</th><th>Tokens</th><th>成本</th><th>来源</th><th>时间</th></tr></thead><tbody>' + detailRows + '</tbody></table>' +
        '</div>' +
        '</div>';
      bindEvents();
    }

    function bindEvents() {
      if (!container || !container.querySelector) return;
      var filterForm = container.querySelector('[data-role="billing-filter-form"]');
      var exportButton = container.querySelector('[data-role="billing-export"]');
      if (filterForm && filterForm.addEventListener) {
        filterForm.addEventListener('submit', function (event) {
          if (event && event.preventDefault) event.preventDefault();
          var startInput = container.querySelector('[data-role="billing-period-start"]');
          var endInput = container.querySelector('[data-role="billing-period-end"]');
          var employeeSelect = container.querySelector('[data-role="billing-employee-filter"]');
          container.lastFilterHandler({
            period_start: startInput && startInput.value,
            period_end: endInput && endInput.value,
            employee_id: employeeSelect && employeeSelect.value,
          });
        });
      }
      var rangeButtons = container.querySelectorAll ? container.querySelectorAll('[data-role="billing-range"]') : [];
      for (var i = 0; i < rangeButtons.length; i += 1) {
        rangeButtons[i].addEventListener('click', function () {
          var key = this.getAttribute('data-range-key') || 'all';
          container.lastQuickRangeHandler(key);
        });
      }
      var rankRows = container.querySelectorAll ? container.querySelectorAll('[data-role="billing-rank-row"]') : [];
      for (var j = 0; j < rankRows.length; j += 1) {
        rankRows[j].addEventListener('click', function () {
          var employeeId = this.getAttribute('data-employee-id') || '';
          container.lastDetailEmployeeHandler(employeeId);
        });
      }
      if (exportButton && exportButton.addEventListener) {
        exportButton.addEventListener('click', function () {
          container.lastExportHandler();
        });
      }
    }

    function loadData() {
      state.loading = true;
      setNotice('');
      var recordsQuery = buildQuery(state);
      var overviewPromise = ns.api.getBillingUsageOverview ? ns.api.getBillingUsageOverview() : ns.api.get(BILLING_OVERVIEW_PATH);
      var recordsPromise = ns.api.getBillingUsageRecords ? ns.api.getBillingUsageRecords(recordsQuery) : ns.api.get(BILLING_RECORDS_PATH + (recordsQuery ? ('?' + recordsQuery) : ''));
      return Promise.all([overviewPromise, recordsPromise]).then(function (results) {
        state.loading = false;
        var overviewResult = results[0];
        var recordsResult = results[1];
        if (!overviewResult.ok) {
          renderNotReady(overviewResult);
          return overviewResult;
        }
        if (!recordsResult.ok) {
          state.overview = overviewResult.data || null;
          state.records = { items: [], total: 0 };
          setNotice('消耗明细加载失败：' + apiErrorMessage(recordsResult));
          if (!state.periodStart) state.periodStart = stringValue(overviewResult.data && overviewResult.data.period_start, '');
          if (!state.periodEnd) state.periodEnd = stringValue(overviewResult.data && overviewResult.data.period_end, '');
          render();
          return recordsResult;
        }
        state.overview = overviewResult.data || null;
        state.records = recordsResult.data || { items: [], total: 0 };
        if (!state.periodStart) state.periodStart = stringValue(overviewResult.data && overviewResult.data.period_start, '');
        if (!state.periodEnd) state.periodEnd = stringValue(overviewResult.data && overviewResult.data.period_end, '');
        render();
        return recordsResult;
      });
    }

    container.lastFilterHandler = function (payload) {
      state.periodStart = String(payload && payload.period_start || '').trim();
      state.periodEnd = String(payload && payload.period_end || '').trim();
      state.employeeId = String(payload && payload.employee_id || '').trim();
      state.detailEmployeeId = state.employeeId;
      state.quickRangeKey = '';
      return loadData();
    };

    container.lastQuickRangeHandler = function (key) {
      var range = resolveQuickRange(key);
      state.quickRangeKey = key;
      state.periodStart = range.start;
      state.periodEnd = range.end;
      return loadData();
    };

    container.lastDetailEmployeeHandler = function (employeeId) {
      state.detailEmployeeId = String(employeeId || '').trim();
      render();
      return state.detailEmployeeId;
    };

    container.lastExportHandler = function () {
      var url = exportUrl();
      if (window.location && typeof window.location.assign === 'function') {
        window.location.assign(url);
      }
      return url;
    };

    return {
      load: loadData,
    };
  }

  ns.pages.adminBilling = {
    init: function (container) {
      if (!container) return;
      var role = ns.role ? ns.role.getActiveRole() : '';
      if (role === 'member') {
        renderPermissionDenied(container);
        return;
      }
      if (!ns.api) {
        container.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>费用 API client 未加载</p></div>';
        return;
      }
      if (ns.states && ns.states.renderLoading) {
        ns.states.renderLoading(container);
      } else {
        container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载费用数据...</p></div>';
      }
      createController(container, role).load();
    },
  };
}(window.aiteam));
