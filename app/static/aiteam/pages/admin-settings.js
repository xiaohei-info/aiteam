window.aiteam = window.aiteam || {};

(function registerAdminSettingsPage(ns) {
  ns.pages = ns.pages || {};

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function stringValue(value, fallback) {
    var text = String(value == null ? '' : value).trim();
    return text || (fallback || '');
  }

  function formatMoneyFromCents(value) {
    return '¥' + (Number(value || 0) / 100).toFixed(2);
  }

  function renderNotImplemented(container) {
    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
      '<h2 class="aiteam-shell__panel-title">企业设置</h2>' +
      '<p class="aiteam-shell__panel-body">设置 API 尚未实现（当前返回 501）。此区域将在后端就绪后展示企业资料、子管理员与邀请码配置。</p>' +
      '</div>';
  }

  function renderSettings(container, data, notice) {
    var notificationPolicy = data && data.notification_policy ? data.notification_policy : {};
    var adminMembers = Array.isArray(data && data.admin_members) ? data.admin_members : [];
    var invites = Array.isArray(data && data.admin_invites) ? data.admin_invites : [];
    var versionLabel = stringValue(data && data.version_label, '未设置');
    var versionNotesUrl = stringValue(data && data.version_notes_url, '');
    var helpDocUrl = stringValue(data && data.help_doc_url, '');
    var feedbackFormUrl = stringValue(data && data.feedback_form_url, '');

    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
      '<h2 class="aiteam-shell__panel-title">企业设置</h2>' +
      '<p class="aiteam-shell__panel-body">通过 /api/team/settings 与 /api/team/settings/admin-invites 管理企业资料、邀请与通知策略。</p>' +
      (notice ? '<div class="aiteam-state aiteam-state-empty"><p>' + esc(notice) + '</p></div>' : '') +
      '<div class="aiteam-grid aiteam-grid--settings">' +
      '<section class="aiteam-panel">' +
      '<div class="aiteam-panel__header"><h3>账户管理</h3><span class="aiteam-inline-note">企业资料 / 邀请码</span></div>' +
      '<div class="aiteam-shell__meta">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">企业名称</span><span class="aiteam-shell__meta-value">' + esc(data && data.name || '未设置') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">Logo</span><span class="aiteam-shell__meta-value">' + esc(data && data.logo_url || '未设置') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">绑定手机号</span><span class="aiteam-shell__meta-value">' + esc(data && data.contact_phone || '未设置') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">绑定微信</span><span class="aiteam-shell__meta-value">' + esc(data && data.contact_wechat || '未设置') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">企业邀请码</span><span class="aiteam-shell__meta-value">' + esc(data && data.invite_code || '未设置') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">低余额预警阈值</span><span class="aiteam-shell__meta-value">' + formatMoneyFromCents(data && data.low_balance_threshold_cents) + '</span></div>' +
      '</div>' +
      '<div class="aiteam-action-row">' +
      '<button type="button" class="aiteam-btn" data-role="save-notification-policy">保存通知策略</button>' +
      '</div>' +
      '</section>' +
      '<section class="aiteam-panel">' +
      '<div class="aiteam-panel__header"><h3>子管理员账号</h3><span class="aiteam-inline-note">成员 / 邀请</span></div>' +
      '<div class="aiteam-stack">' +
      (adminMembers.length ? adminMembers.map(function (item) {
        return '<div class="aiteam-card"><div class="aiteam-card__row"><strong>' + esc(item.user_id || '未命名') + '</strong><span class="aiteam-badge">' + esc(item.role || 'unknown') + '</span></div><div class="aiteam-card__meta"><span>状态 ' + esc(item.status || 'unknown') + '</span><span>加入于 ' + esc(item.joined_at || '-') + '</span></div></div>';
      }).join('') : '<div class="aiteam-inline-empty">暂无子管理员</div>') +
      '</div>' +
      '<div class="aiteam-stack">' +
      '<div class="aiteam-card"><div class="aiteam-card__row"><strong>待处理邀请</strong><span class="aiteam-inline-note">输入手机号发送邀请</span></div>' +
      '<div class="aiteam-action-row"><button type="button" class="aiteam-btn" data-role="create-admin-invite">生成邀请</button></div>' +
      (invites.length ? invites.map(function (item) {
        return '<div class="aiteam-card__meta"><span>' + esc(item.phone || '-') + '</span><span>' + esc(item.role || 'member') + '</span><span>' + esc(item.status || 'pending') + '</span><span>' + esc(item.invite_code || '-') + '</span><button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="revoke-admin-invite" data-invite-id="' + esc(item.invite_id || '') + '">撤销邀请</button></div>';
      }).join('') : '<div class="aiteam-inline-empty">暂无邀请码</div>') +
      '</div>' +
      '</div>' +
      '</section>' +
      '<section class="aiteam-panel">' +
      '<div class="aiteam-panel__header"><h3>其他设置</h3><span class="aiteam-inline-note">版本 / 帮助 / 通知</span></div>' +
      '<div class="aiteam-shell__meta">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">当前版本</span><span class="aiteam-shell__meta-value">' + esc(versionLabel) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">检查更新</span><span class="aiteam-shell__meta-value">' + (versionNotesUrl ? '<a href="' + esc(versionNotesUrl) + '">查看更新日志</a>' : '未配置') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">帮助与反馈</span><span class="aiteam-shell__meta-value">' + (helpDocUrl ? '<a href="' + esc(helpDocUrl) + '">在线文档</a>' : '未配置') + (feedbackFormUrl ? ' / <a href="' + esc(feedbackFormUrl) + '">提交问题表单</a>' : '') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">通知设置</span><ul class="aiteam-shell__list">' +
      '<li>员工任务完成通知：' + (notificationPolicy.employee_task_completed ? '开启' : '关闭') + '</li>' +
      '<li>系统公告：' + (notificationPolicy.system_announcements ? '开启' : '关闭') + '</li>' +
      '<li>低余额邮件预警：' + (notificationPolicy.low_balance_email ? '开启' : '关闭') + '</li>' +
      '</ul></div>' +
      '</div>' +
      '</section>' +
      '</div>' +
      '</div>';
  }

  function bindSettingsActions(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    var saveButton = container.querySelector('[data-role="save-notification-policy"]');
    var createInviteButton = container.querySelector('[data-role="create-admin-invite"]');
    var revokeButtons = container.querySelectorAll('[data-role="revoke-admin-invite"]');

    if (saveButton && typeof saveButton.addEventListener === 'function') {
      saveButton.addEventListener('click', function () {
        if (typeof container.lastPatchHandler === 'function') {
          container.lastPatchHandler({
            notification_policy: {
              employee_task_completed: true,
              system_announcements: true,
              low_balance_email: true,
            },
          });
        }
      });
    }
    if (createInviteButton && typeof createInviteButton.addEventListener === 'function') {
      createInviteButton.addEventListener('click', function () {
        if (typeof container.lastInviteHandler === 'function') {
          container.lastInviteHandler({
            phone: '13900002222',
            role: 'enterprise_admin',
            idempotency_key: 'ui-admin-invite-create',
          });
        }
      });
    }
    for (var i = 0; i < revokeButtons.length; i++) {
      revokeButtons[i].addEventListener('click', function () {
        var inviteId = this.getAttribute('data-invite-id');
        if (inviteId && typeof container.lastDeleteInviteHandler === 'function') {
          container.lastDeleteInviteHandler(inviteId);
        }
      });
    }
  }

  ns.pages.adminSettings = {
    init: function (container) {
      if (!container) return;

      container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载企业设置...</p></div>';

      var settingsData = null;

      function refreshNotice(message) {
        if (settingsData) {
          renderSettings(container, settingsData, message);
          bindSettingsActions(container);
        }
      }

      container.lastPatchHandler = function (payload) {
        return ns.api.patch('/api/team/settings', payload || {}).then(function (result) {
          if (result && result.ok) {
            settingsData = Object.assign({}, settingsData || {}, payload || {});
            refreshNotice('企业设置已提交更新');
            return result;
          }
          refreshNotice('企业设置更新失败');
          return result;
        });
      };

      container.lastInviteHandler = function (payload) {
        return ns.api.post('/api/team/settings/admin-invites', payload || {}).then(function (result) {
          if (result && result.ok) {
            settingsData = Object.assign({}, settingsData || {});
            settingsData.admin_invites = (settingsData.admin_invites || []).concat([result.data || payload || {}]);
            refreshNotice('已生成新的管理员邀请');
            return result;
          }
          refreshNotice('管理员邀请创建失败');
          return result;
        });
      };

      container.lastDeleteInviteHandler = function (inviteId) {
        return ns.api.delete('/api/team/settings/admin-invites/' + encodeURIComponent(inviteId)).then(function (result) {
          if (result && result.ok) {
            settingsData = Object.assign({}, settingsData || {});
            settingsData.admin_invites = (settingsData.admin_invites || []).filter(function (item) {
              return item.invite_id !== inviteId;
            });
            refreshNotice('管理员邀请已撤销');
            return result;
          }
          refreshNotice('管理员邀请撤销失败');
          return result;
        });
      };

      ns.api.get('/api/team/settings').then(function (result) {
        if (!result.ok) {
          if (result.status === 501) {
            renderNotImplemented(container);
            return;
          }
          if (ns.states && ns.states.handleApiResult) {
            ns.states.handleApiResult(result, container, function () {});
          } else {
            container.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>⚠ 企业设置加载失败</p></div>';
          }
          return;
        }
        settingsData = result.data || {};
        renderSettings(container, settingsData, '');
        bindSettingsActions(container);
      });
    }
  };
}(window.aiteam));
