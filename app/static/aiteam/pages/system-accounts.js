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
              '<p class="aiteam-shell__panel-body">企业账号 API 尚未实现（当前返回 501）。此区域将在后端就绪后展示企业列表与系统管理操作。</p>' +
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

        var rows = data.enterprises.map(function (e) {
          var enterpriseId = e.enterprise_id || '';
          return '<tr>' +
            '<td>' + enterpriseId + '</td>' +
            '<td>' + (e.name || '') + '</td>' +
            '<td>' + (e.status || '') + '</td>' +
            '<td>' + (e.plan || '') + '</td>' +
            '<td>' + (typeof e.balance === 'number' ? e.balance : '—') + '</td>' +
            '<td>' + actionMarkup(enterpriseId) + '</td>' +
            '</tr>';
        }).join('');

        container.innerHTML =
          '<div class="aiteam-shell__panel">' +
          '<h2 class="aiteam-shell__panel-title">企业账号管理</h2>' +
          '<p class="aiteam-shell__panel-body">通过 /api/system-admin/enterprises 消费企业账号数据。</p>' +
          (canMutate ? '' : '<p class="aiteam-shell__meta">当前角色仅可查看企业账号，企业操作需要 system_write 权限。</p>') +
          '<table class="aiteam-table"><thead><tr><th>企业ID</th><th>名称</th><th>状态</th><th>方案</th><th>余额</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<div id="aiteam-sys-accounts-feedback"></div>' +
          '</div>';

        if (!canMutate || !container.querySelectorAll) return;
        var buttons = container.querySelectorAll('button[data-aiteam-action]');
        for (var i = 0; i < buttons.length; i++) {
          buttons[i].addEventListener('click', function (ev) {
            var btn = ev.currentTarget;
            var eid = btn.getAttribute('data-aiteam-eid');
            var action = btn.getAttribute('data-aiteam-action');
            ns.pages.systemAccounts.performAction(eid, action);
          });
        }
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
