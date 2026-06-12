// system-accounts.js — System Admin enterprise account management shell
window.aiteam = window.aiteam || {};

(function registerSystemAccountsPage(ns) {
  ns.pages = ns.pages || {};

  var NOTIFY_LEVELS = { info: true, warning: true, critical: true };

  function findById(id) {
    if (typeof document === 'undefined' || !document.getElementById) return null;
    return document.getElementById(id);
  }

  function getWindow() {
    if (typeof window !== 'undefined') return window;
    return null;
  }

  function promptValue(message, defaultValue) {
    var win = getWindow();
    if (!win || typeof win.prompt !== 'function') return defaultValue || '';
    var value = win.prompt(message, defaultValue || '');
    if (value === null) return null;
    return String(value);
  }

  function confirmValue(message) {
    var win = getWindow();
    if (!win || typeof win.confirm !== 'function') return true;
    return !!win.confirm(message);
  }

  function buildIdempotencyKey(enterpriseId, action) {
    return 'system-accounts-' + enterpriseId + '-' + action + '-' + Date.now();
  }

  function trimText(value) {
    if (value === undefined || value === null) return '';
    return String(value).replace(/^\s+|\s+$/g, '');
  }

  function escapeHtmlAttr(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function formatMoney(value) {
    var num = Number(value);
    if (!isFinite(num)) return '—';
    return '¥' + num.toLocaleString('en-US');
  }

  function formatTokens(value) {
    var num = Number(value);
    if (!isFinite(num)) return '—';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M tokens';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K tokens';
    return String(num) + ' tokens';
  }

  function statusLabel(value) {
    var status = String(value || '').toLowerCase();
    if (status === 'active' || status === 'normal') return '正常';
    if (status === 'suspended' || status === 'banned') return '封禁';
    if (status === 'arrears' || status === 'low_balance') return '欠费';
    return value || '未知';
  }

  function statusClass(value) {
    var status = String(value || '').toLowerCase();
    if (status === 'active' || status === 'normal') return 'is-ok';
    if (status === 'suspended' || status === 'banned') return 'is-bad';
    return 'is-warn';
  }

  function _renderPermissionDenied(container) {
    if (!container) return;
    if (ns.states && ns.states.renderPermissionDenied) {
      ns.states.renderPermissionDenied(container);
      return;
    }
    container.innerHTML = '<div class="aiteam-state aiteam-state-denied"><p>您没有权限访问此内容</p></div>';
  }

  function _currentRole() {
    return ns.role ? ns.role.getActiveRole() : '';
  }

  function _hasSystemRead(role) {
    return !role || !ns.role || !ns.role.hasPermission || ns.role.hasPermission(role, 'system_read');
  }

  function _hasSystemWrite(role) {
    return !role || !ns.role || !ns.role.hasPermission || ns.role.hasPermission(role, 'system_write');
  }

  function _setFeedback(html) {
    var fb = findById('aiteam-sys-accounts-feedback');
    if (fb) fb.innerHTML = html;
  }

  function collectActionRequest(enterpriseId, action, overrides) {
    var payload = { action: action };
    var provided = overrides || {};
    var reason = '';
    var amountText = '';
    var message = '';
    var level = '';
    var confirmMessage = '确认对企业 ' + enterpriseId + ' 执行 ' + action + ' 操作？';

    if (action === 'ban' || action === 'unban') {
      reason = trimText(provided.reason);
      if (!reason) {
        reason = trimText(promptValue('请输入' + (action === 'ban' ? '封禁' : '解封') + '原因（可选）：', ''));
      }
      if (reason) payload.reason = reason;
      if (!confirmValue(confirmMessage + (reason ? '\n原因：' + reason : ''))) {
        return { cancelled: true, error: 'cancelled' };
      }
      return { payload: payload };
    }

    if (action === 'recharge') {
      amountText = trimText(provided.amount);
      if (!amountText) {
        amountText = trimText(promptValue('请输入充值金额（最小货币单位整数）：', ''));
      }
      if (!amountText) return { cancelled: true, error: 'amount_required' };
      if (!/^-?\d+$/.test(amountText)) return { cancelled: true, error: 'amount_invalid' };
      payload.amount = parseInt(amountText, 10);
      payload.idempotency_key = trimText(provided.idempotency_key) || buildIdempotencyKey(enterpriseId, action);
      if (!confirmValue(confirmMessage + '\n金额：' + payload.amount)) {
        return { cancelled: true, error: 'cancelled' };
      }
      return { payload: payload };
    }

    if (action === 'notify') {
      message = trimText(provided.message);
      if (!message) message = trimText(promptValue('请输入通知内容：', ''));
      if (!message) return { cancelled: true, error: 'message_required' };
      level = trimText(provided.level).toLowerCase();
      if (!level) {
        level = trimText(promptValue('请输入通知级别（info / warning / critical，默认 info）：', 'info')).toLowerCase();
      }
      if (!NOTIFY_LEVELS[level]) level = 'info';
      payload.message = message;
      payload.level = level;
      payload.idempotency_key = trimText(provided.idempotency_key) || buildIdempotencyKey(enterpriseId, action);
      if (!confirmValue(confirmMessage + '\n级别：' + level + '\n内容：' + message)) {
        return { cancelled: true, error: 'cancelled' };
      }
      return { payload: payload };
    }

    return { cancelled: true, error: 'unsupported_action' };
  }

  function _withinCreatedRange(item, rawRange) {
    var range = trimText(rawRange);
    if (!range) return true;
    var parts = range.split('~');
    if (parts.length !== 2) return true;
    var start = trimText(parts[0]);
    var end = trimText(parts[1]);
    var created = String(item.created_at || '').slice(0, 10);
    if (start && created < start) return false;
    if (end && created > end) return false;
    return true;
  }

  function filterEnterprises(items, state) {
    return (items || []).filter(function (item) {
      if (!_withinCreatedRange(item, state.createdRange)) return false;
      if (state.statusFilter && String(item.status || '').toLowerCase() !== state.statusFilter) return false;
      if (!state.query) return true;
      var haystack = [
        item.name,
        item.owner_name,
        item.owner_phone,
        item.enterprise_id,
      ].join(' ').toLowerCase();
      return haystack.indexOf(trimText(state.query).toLowerCase()) !== -1;
    });
  }

  function buildStats(items) {
    var total = items.length;
    var active = items.filter(function (item) { return String(item.status || '').toLowerCase() === 'active'; });
    var monthNew = items.filter(function (item) {
      return String(item.created_at || '').slice(0, 7) === '2026-06';
    });
    var totalRecharge = items.reduce(function (sum, item) {
      return sum + (Number(item.total_recharged) || 0);
    }, 0);
    return {
      total: total,
      monthNew: monthNew.length,
      active: active.length,
      rechargeTotal: totalRecharge,
    };
  }

  function renderDetail(selected) {
    if (!selected) {
      return '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">企业账号详情</span><span class="aiteam-shell__meta-value">选择企业后查看详情</span></div>';
    }
    return '' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">企业账号详情</span><span class="aiteam-shell__meta-value">' + (selected.name || '') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">联系人 / 手机</span><span class="aiteam-shell__meta-value">' + ((selected.owner_name || '—') + ' / ' + (selected.owner_phone || '—')) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">注册时间</span><span class="aiteam-shell__meta-value">' + (selected.created_at || '—') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">累计充值</span><span class="aiteam-shell__meta-value">' + formatMoney(selected.total_recharged || selected.balance || 0) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">Token消耗</span><span class="aiteam-shell__meta-value">' + formatTokens(selected.total_tokens_used || 0) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">状态</span><span class="aiteam-shell__meta-value">' + statusLabel(selected.status) + '</span></div>';
  }

  function renderRechargeHistory(selected) {
    if (!selected) {
      return '<div class="aiteam-inline-empty">暂无充值记录</div>';
    }
    return '' +
      '<div class="aiteam-card__meta"><span>累计充值</span><span>' + formatMoney(selected.total_recharged || selected.balance || 0) + '</span></div>' +
      '<div class="aiteam-card__meta"><span>最近活跃</span><span>' + (selected.last_active_at || '—') + '</span></div>' +
      '<div class="aiteam-inline-note">充值明细后续由系统账本聚合承接；当前保留手动充值动作与总额展示。</div>';
  }

  function renderEmployeeDigest(selected, detailQuota) {
    if (!selected) {
      return '<div class="aiteam-inline-empty">暂无员工列表</div>';
    }
    return '' +
      '<div class="aiteam-card__meta"><span>当前员工数量</span><span>' + (selected.agent_count != null ? selected.agent_count : '—') + '</span></div>' +
      '<div class="aiteam-card__meta"><span>员工上限</span><span>' + (detailQuota && detailQuota.employee_quota != null ? detailQuota.employee_quota : '—') + '</span></div>' +
      '<div class="aiteam-inline-note">员工列表入口保留在企业后台员工管理页，这里先提供系统治理摘要。</div>';
  }

  function renderTokenHistory(selected) {
    if (!selected) {
      return '<div class="aiteam-inline-empty">暂无 Token 消耗历史</div>';
    }
    return '' +
      '<div class="aiteam-card__meta"><span>累计消耗</span><span>' + formatTokens(selected.total_tokens_used || 0) + '</span></div>' +
      '<div class="aiteam-card__meta"><span>最近活跃时间</span><span>' + (selected.last_active_at || '—') + '</span></div>' +
      '<div class="aiteam-inline-note">明细可在「财务管理」页查看。</div>';
  }

  function renderExportSummary(items) {
    var count = (items || []).length;
    return '' +
      '<div class="aiteam-card__meta"><span>数据导出</span><span>共 ' + count + ' 家企业</span></div>' +
      '<div class="aiteam-action-row"><button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="enterprise-export">导出 CSV</button></div>';
  }

  function downloadEnterprisesCsv(items) {
    var rows = items || [];
    var header = ['企业ID', '企业名称', '状态', '注册时间', '累计充值(分)', 'Token消耗'];
    var lines = [header.join(',')].concat(rows.map(function (item) {
      return [
        item.id || item.enterprise_id || '',
        '"' + String(item.name || '').replace(/"/g, '""') + '"',
        item.status || '',
        item.created_at || '',
        item.total_recharged_cents != null ? item.total_recharged_cents : (item.total_recharged || ''),
        item.total_tokens_used || 0,
      ].join(',');
    }));
    var blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'enterprises.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  function renderQuota(detailQuota) {
    if (!detailQuota) {
      return '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">企业配额</span><span class="aiteam-shell__meta-value">正在加载</span></div>';
    }
    return '' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">企业配额</span><span class="aiteam-shell__meta-value">企业 ' + (detailQuota.id || '-') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">员工上限</span><span class="aiteam-shell__meta-value">' + (detailQuota.employee_quota != null ? detailQuota.employee_quota : '—') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">存储配额</span><span class="aiteam-shell__meta-value">' + (detailQuota.storage_quota_mb != null ? detailQuota.storage_quota_mb + ' MB' : '—') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">API 限流</span><span class="aiteam-shell__meta-value">' + (detailQuota.api_rate_limit != null ? detailQuota.api_rate_limit : '—') + '</span></div>';
  }

  ns.pages.systemAccounts = {
    init: function (container) {
      if (!container) return;

      var role = _currentRole();
      if (!_hasSystemRead(role)) {
        _renderPermissionDenied(container);
        return;
      }

      if (ns.states && ns.states.renderLoading) {
        ns.states.renderLoading(container);
      } else {
        container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载企业账号数据...</p></div>';
      }

      ns.api.get('/api/system-admin/enterprises').then(function (result) {
        if (!result.ok) {
          if (result.status === 501) {
            container.innerHTML =
              '<div class="aiteam-shell__panel">' +
              '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
              '<h2 class="aiteam-shell__panel-title">企业账号管理</h2>' +
              '<p class="aiteam-shell__panel-body">企业账号数据暂时不可用，请稍后刷新重试。</p>' +
              '</div>';
            return;
          }
          if (ns.states && ns.states.handleApiResult) {
            ns.states.handleApiResult(result, container, function () {});
          } else {
            container.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>⚠ 企业账号数据加载失败</p></div>';
          }
          return;
        }
        var data = result.data;
        if (!data || !data.enterprises || data.enterprises.length === 0) {
          if (ns.states && ns.states.renderEmpty) {
            ns.states.renderEmpty(container, '暂无企业账号');
          }
          return;
        }

        var canMutate = _hasSystemWrite(role);
        var state = {
          query: '',
          statusFilter: '',
          createdRange: '',
          selectedEnterpriseId: data.enterprises[0].enterprise_id || '',
          selectedDetail: null,
          selectedQuota: null,
          exportItems: [],
        };

        function refreshSelectedEnterpriseData() {
          if (!state.selectedEnterpriseId || !ns.api || !ns.api.getSystemEnterpriseDetail || !ns.api.getSystemEnterpriseQuota || !ns.api.getSystemEnterpriseExport) {
            return Promise.resolve();
          }
          return Promise.all([
            ns.api.getSystemEnterpriseDetail(state.selectedEnterpriseId),
            ns.api.getSystemEnterpriseQuota(state.selectedEnterpriseId),
            ns.api.getSystemEnterpriseExport(),
          ]).then(function (results) {
            if (results[0] && results[0].ok) state.selectedDetail = results[0].data || null;
            if (results[1] && results[1].ok) state.selectedQuota = results[1].data || null;
            if (results[2] && results[2].ok) state.exportItems = (results[2].data && results[2].data.items) || [];
          });
        }

        function render() {
          var filtered = filterEnterprises(data.enterprises, state);
          var stats = buildStats(data.enterprises);
          var selected = filtered.find(function (item) { return item.enterprise_id === state.selectedEnterpriseId; }) || filtered[0] || data.enterprises[0];
          state.selectedEnterpriseId = selected ? selected.enterprise_id : '';
          if (state.selectedDetail && state.selectedDetail.id !== state.selectedEnterpriseId) state.selectedDetail = null;
          if (state.selectedQuota && state.selectedQuota.id !== state.selectedEnterpriseId) state.selectedQuota = null;
          var actionMarkup = canMutate
            ? function (enterpriseId) {
                return '<button class="aiteam-btn aiteam-btn--sm" data-aiteam-action="ban" data-aiteam-eid="' + enterpriseId + '">封禁</button> ' +
                  '<button class="aiteam-btn aiteam-btn--sm" data-aiteam-action="unban" data-aiteam-eid="' + enterpriseId + '">解封</button> ' +
                  '<button class="aiteam-btn aiteam-btn--sm" data-aiteam-action="recharge" data-aiteam-eid="' + enterpriseId + '">充值</button> ' +
                  '<button class="aiteam-btn aiteam-btn--sm" data-aiteam-action="notify" data-aiteam-eid="' + enterpriseId + '">通知</button>';
              }
            : function () {
                return '<span class="aiteam-shell__meta-value">只读</span>';
              };

          var rows = filtered.map(function (e) {
            var enterpriseId = e.enterprise_id || '';
            var active = state.selectedEnterpriseId === enterpriseId ? ' class="aiteam-employee-row"' : ' class="aiteam-employee-row"';
            return '<tr' + active + ' data-enterprise-row="' + enterpriseId + '">' +
              '<td>' + (e.name || '') + '</td>' +
              '<td>' + ((e.owner_name || '—') + ' / ' + (e.owner_phone || '—')) + '</td>' +
              '<td>' + (e.created_at || '') + '</td>' +
              '<td>' + formatMoney(e.total_recharged || e.balance || 0) + '</td>' +
              '<td>' + formatTokens(e.total_tokens_used || 0) + '</td>' +
              '<td><span class="aiteam-office__task-chip ' + statusClass(e.status) + '">' + statusLabel(e.status) + '</span></td>' +
              '<td>' + actionMarkup(enterpriseId) + '</td>' +
              '</tr>';
          }).join('');

          container.innerHTML =
            '<div class="aiteam-shell__panel">' +
            '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
            '<h2 class="aiteam-shell__panel-title">企业账号管理</h2>' +
            '<p class="aiteam-shell__panel-body">管理平台上的企业账号：查看企业概况与配额，执行充值、封禁、解封与通知等运营操作。</p>' +
            '<div class="aiteam-billing__stats">' +
            '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">总企业数</span><span class="aiteam-shell__meta-value">' + stats.total + '</span></div>' +
            '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">本月新增</span><span class="aiteam-shell__meta-value">' + stats.monthNew + '</span></div>' +
            '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">月活企业</span><span class="aiteam-shell__meta-value">' + stats.active + '</span></div>' +
            '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">总充值</span><span class="aiteam-shell__meta-value">' + formatMoney(stats.rechargeTotal) + '</span></div>' +
            '</div>' +
            '<div class="aiteam-shell__meta">' +
            '<div class="aiteam-shell__meta-card"><label>搜索企业名称/手机号/邮箱<br><input class="aiteam-input" type="search" data-role="enterprise-search" value="' + state.query + '" placeholder="搜索企业名称/手机号/邮箱"></label></div>' +
            '<div class="aiteam-shell__meta-card"><label>状态筛选<br><select class="aiteam-input" data-role="enterprise-status"><option value="">全部</option><option value="active"' + (state.statusFilter === 'active' ? ' selected' : '') + '>正常</option><option value="arrears"' + (state.statusFilter === 'arrears' ? ' selected' : '') + '>欠费</option><option value="suspended"' + (state.statusFilter === 'suspended' ? ' selected' : '') + '>封禁</option></select></label></div>' +
            '<div class="aiteam-shell__meta-card"><label>注册时间范围<br><input class="aiteam-input" type="text" data-role="enterprise-created-range" value="' + escapeHtmlAttr(state.createdRange) + '" placeholder="YYYY-MM-DD ~ YYYY-MM-DD"></label></div>' +
            '<div class="aiteam-shell__meta-card">' + renderExportSummary(state.exportItems) + '</div>' +
            '</div>' +
            '<div class="aiteam-shell__two-column">' +
            '<div class="aiteam-shell__panel">' +
            '<table class="aiteam-table"><thead><tr><th>企业名称</th><th>联系人/手机</th><th>注册时间</th><th>累计充值</th><th>Token消耗</th><th>状态</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>' +
            '</div>' +
            '<div class="aiteam-shell__panel"><h3 class="aiteam-shell__panel-title">企业账号详情</h3><div class="aiteam-shell__meta">' + renderDetail(state.selectedDetail || selected) + renderQuota(state.selectedQuota) + '</div>' +
            '<div class="aiteam-panel__header"><h3>基本信息</h3><span class="aiteam-inline-note">企业基础资料 / 配额</span></div>' +
            '<div class="aiteam-shell__meta">' + renderDetail(state.selectedDetail || selected) + '</div>' +
            '<div class="aiteam-panel__header"><h3>充值记录</h3><span class="aiteam-inline-note">手动充值 / 总额摘要</span></div>' +
            '<div class="aiteam-stack">' + renderRechargeHistory(selected) + '</div>' +
            '<div class="aiteam-panel__header"><h3>员工列表</h3><span class="aiteam-inline-note">企业侧员工治理摘要</span></div>' +
            '<div class="aiteam-stack">' + renderEmployeeDigest(selected, state.selectedQuota) + '</div>' +
            '<div class="aiteam-panel__header"><h3>Token消耗历史</h3><span class="aiteam-inline-note">使用量追踪摘要</span></div>' +
            '<div class="aiteam-stack">' + renderTokenHistory(selected) + '</div></div>' +
            '</div>' +
            (canMutate ? '' : '<p class="aiteam-shell__meta">当前角色仅可查看企业账号，企业操作需要 system_write 权限。</p>') +
            '<div id="aiteam-sys-accounts-feedback"></div>' +
            '</div>';

          if (container.querySelector) {
            var search = container.querySelector('[data-role="enterprise-search"]');
            var filter = container.querySelector('[data-role="enterprise-status"]');
            var createdRangeInput = container.querySelector('[data-role="enterprise-created-range"]');
            if (search && search.addEventListener) {
              search.addEventListener('input', function () {
                state.query = this.value || '';
                render();
              });
            }
            if (filter && filter.addEventListener) {
              filter.addEventListener('change', function () {
                state.statusFilter = this.value || '';
                render();
              });
            }
            if (createdRangeInput && createdRangeInput.addEventListener) {
              createdRangeInput.addEventListener('input', function () {
                state.createdRange = this.value || '';
                render();
              });
            }
            var exportButton = container.querySelector('[data-role="enterprise-export"]');
            if (exportButton && exportButton.addEventListener) {
              exportButton.addEventListener('click', function () {
                downloadEnterprisesCsv(state.exportItems);
              });
            }
          }

          if (container.querySelectorAll) {
            var rowsEls = container.querySelectorAll('[data-enterprise-row]');
            for (var i = 0; i < rowsEls.length; i++) {
              rowsEls[i].addEventListener('click', function () {
                state.selectedEnterpriseId = this.getAttribute('data-enterprise-row') || '';
                refreshSelectedEnterpriseData().then(render);
              });
            }
            if (canMutate) {
              var buttons = container.querySelectorAll('button[data-aiteam-action]');
              for (var j = 0; j < buttons.length; j++) {
                buttons[j].addEventListener('click', function (ev) {
                  var btn = ev.currentTarget;
                  var eid = btn.getAttribute('data-aiteam-eid');
                  var action = btn.getAttribute('data-aiteam-action');
                  ns.pages.systemAccounts.performAction(eid, action);
                });
              }
            }
          }
        }

        refreshSelectedEnterpriseData().then(render);
      });
    },

    collectActionRequest: function (enterpriseId, action, overrides) {
      return collectActionRequest(enterpriseId, action, overrides);
    },

    performAction: function (enterpriseId, action, overrides) {
      var role = _currentRole();
      if (!_hasSystemWrite(role)) {
        _setFeedback('<p class="aiteam-state aiteam-state-denied">您没有执行系统操作的权限</p>');
        return Promise.resolve({ ok: false, status: 403, data: null, error: 'permission_denied' });
      }
      var request = collectActionRequest(enterpriseId, action, overrides);
      if (!request || request.cancelled) {
        return Promise.resolve({ ok: false, status: 0, data: null, error: request ? request.error : 'cancelled' });
      }
      return ns.api.post('/api/system-admin/enterprises/' + encodeURIComponent(enterpriseId) + '/actions', request.payload).then(function (result) {
        if (result.ok) {
          _setFeedback('<p class="aiteam-state aiteam-state-success">操作 ' + action + ' 已提交（企业 ' + enterpriseId + '）。</p>');
        } else {
          _setFeedback('<p class="aiteam-state aiteam-state-error">操作 ' + action + ' 失败：' + (result.error || '未知错误') + '</p>');
        }
        return result;
      });
    },
  };
}(window.aiteam));
