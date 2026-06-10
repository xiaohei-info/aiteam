window.aiteam = window.aiteam || {};

(function registerAdminSettingsPage(ns) {
  ns.pages = ns.pages || {};

  var INVITE_PERMISSION_OPTIONS = [
    { key: 'billing', label: '财务与充值' },
    { key: 'employees', label: '员工与组织' },
    { key: 'audit', label: '审计与日志' }
  ];

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

  function parseInteger(value, fallback) {
    var num = Number(value);
    return isFinite(num) ? Math.round(num) : fallback;
  }

  function formatMoneyFromCents(value) {
    return '¥' + (Number(value || 0) / 100).toFixed(2);
  }

  function boolLabel(value) {
    return value ? '开启' : '关闭';
  }

  function roleLabel(role) {
    if (role === 'owner') return '所有者';
    if (role === 'enterprise_admin') return '企业管理员';
    if (role === 'finance_admin') return '财务管理员';
    return role || '未设置';
  }

  function defaultPermissionsForRole(role) {
    if (role === 'owner') {
      return ['财务与充值', '员工与组织', '审计与日志'];
    }
    if (role === 'enterprise_admin') {
      return ['员工与组织', '审计与日志'];
    }
    if (role === 'finance_admin') {
      return ['财务与充值', '审计与日志'];
    }
    return ['待补充'];
  }

  function permissionLabels(permissions, role) {
    if (permissions && typeof permissions === 'object') {
      var labels = [];
      for (var i = 0; i < INVITE_PERMISSION_OPTIONS.length; i++) {
        var option = INVITE_PERMISSION_OPTIONS[i];
        if (permissions[option.key]) labels.push(option.label);
      }
      if (labels.length) return labels;
    }
    return defaultPermissionsForRole(role);
  }

  function renderPermissionBadges(permissions, role) {
    var labels = permissionLabels(permissions, role);
    var html = [];
    for (var i = 0; i < labels.length; i++) {
      html.push('<span class="aiteam-badge">' + esc(labels[i]) + '</span>');
    }
    return html.join(' ');
  }

  function renderNotImplemented(container) {
    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
      '<h2 class="aiteam-shell__panel-title">企业设置</h2>' +
      '<p class="aiteam-shell__panel-body">设置 API 尚未实现（当前返回 501）。此区域将在后端就绪后展示企业资料、子管理员与邀请码配置。</p>' +
      '</div>';
  }

  function renderAccountSection(data) {
    return '' +
      '<section class="aiteam-panel">' +
      '<div class="aiteam-panel__header"><h3>账户管理</h3><span class="aiteam-inline-note">企业资料 / 邀请码 / 更换绑定信息</span></div>' +
      '<div class="aiteam-stack">' +
      '<label class="aiteam-inline-note">企业名称</label>' +
      '<input class="aiteam-input" data-role="settings-name" value="' + esc(data && data.name || '') + '" placeholder="请输入企业名称" />' +
      '<label class="aiteam-inline-note">Logo 上传</label>' +
      '<input class="aiteam-input" data-role="settings-logo-url" value="' + esc(data && data.logo_url || '') + '" placeholder="上传结果图片地址或 CDN URL" />' +
      '<div class="aiteam-inline-note">Logo 上传：当前后端通过 <code>logo_url</code> 承接上传结果，保留“正方形，≤2MB”的原型约束提示。</div>' +
      '<label class="aiteam-inline-note">绑定手机号</label>' +
      '<input class="aiteam-input" data-role="settings-contact-phone" value="' + esc(data && data.contact_phone || '') + '" placeholder="请输入绑定手机号" />' +
      '<label class="aiteam-inline-note">绑定微信</label>' +
      '<input class="aiteam-input" data-role="settings-contact-wechat" value="' + esc(data && data.contact_wechat || '') + '" placeholder="请输入企业微信号" />' +
      '<div class="aiteam-shell__meta">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">企业邀请码</span><span class="aiteam-shell__meta-value">' + esc(data && data.invite_code || '未设置') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">低余额预警阈值</span><span class="aiteam-shell__meta-value">' + formatMoneyFromCents(data && data.low_balance_threshold_cents) + '</span></div>' +
      '</div>' +
      '<div class="aiteam-action-row">' +
      '<button type="button" class="aiteam-btn" data-role="save-profile-settings">保存企业资料</button>' +
      '</div>' +
      '</div>' +
      '</section>';
  }

  function renderMemberCards(adminMembers) {
    if (!adminMembers.length) {
      return '<div class="aiteam-inline-empty">暂无子管理员</div>';
    }
    return adminMembers.map(function (item) {
      return '' +
        '<div class="aiteam-card">' +
        '<div class="aiteam-card__row"><strong>' + esc(item.user_id || '未命名') + '</strong><span class="aiteam-badge">' + esc(roleLabel(item.role || '')) + '</span></div>' +
        '<div class="aiteam-card__meta"><span>状态 ' + esc(item.status || 'unknown') + '</span><span>加入于 ' + esc(item.joined_at || '-') + '</span></div>' +
        '<div class="aiteam-card__meta"><span>权限范围</span><span>' + renderPermissionBadges(item.permissions, item.role) + '</span></div>' +
        '</div>';
    }).join('');
  }

  function renderInviteCards(invites) {
    if (!invites.length) {
      return '<div class="aiteam-inline-empty">暂无邀请码</div>';
    }
    return invites.map(function (item) {
      return '' +
        '<div class="aiteam-card">' +
        '<div class="aiteam-card__row"><strong>' + esc(item.phone || '-') + '</strong><span class="aiteam-badge">' + esc(roleLabel(item.role || '')) + '</span></div>' +
        '<div class="aiteam-card__meta"><span>状态 ' + esc(item.status || 'pending') + '</span><span>邀请码 ' + esc(item.invite_code || '-') + '</span></div>' +
        '<div class="aiteam-card__meta"><span>权限范围</span><span>' + renderPermissionBadges(item.permissions, item.role) + '</span></div>' +
        (item.message ? '<div class="aiteam-card__meta"><span>留言</span><span>' + esc(item.message) + '</span></div>' : '') +
        '<div class="aiteam-action-row"><button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="revoke-admin-invite" data-invite-id="' + esc(item.invite_id || '') + '">撤销邀请</button></div>' +
        '</div>';
    }).join('');
  }

  function renderInvitePermissions() {
    return INVITE_PERMISSION_OPTIONS.map(function (option) {
      return '' +
        '<label class="aiteam-card__meta">' +
        '<input type="checkbox" data-role="invite-permission" data-permission-key="' + esc(option.key) + '" />' +
        '<span>' + esc(option.label) + '</span>' +
        '</label>';
    }).join('');
  }

  function renderAdminSection(data) {
    var adminMembers = Array.isArray(data && data.admin_members) ? data.admin_members : [];
    var invites = Array.isArray(data && data.admin_invites) ? data.admin_invites : [];
    return '' +
      '<section class="aiteam-panel">' +
      '<div class="aiteam-panel__header"><h3>子管理员账号</h3><span class="aiteam-inline-note">列表 / 邀请 / 权限范围</span></div>' +
      '<div class="aiteam-stack">' +
      renderMemberCards(adminMembers) +
      '</div>' +
      '<div class="aiteam-stack">' +
      '<div class="aiteam-card">' +
      '<div class="aiteam-card__row"><strong>新增子管理员</strong><span class="aiteam-inline-note">输入手机号并发送邀请</span></div>' +
      '<label class="aiteam-inline-note">手机号</label>' +
      '<input class="aiteam-input" data-role="invite-phone" value="" placeholder="请输入手机号" />' +
      '<label class="aiteam-inline-note">角色</label>' +
      '<select class="aiteam-select" data-role="invite-role">' +
      '<option value="enterprise_admin">企业管理员</option>' +
      '<option value="finance_admin">财务管理员</option>' +
      '<option value="owner">所有者</option>' +
      '</select>' +
      '<div class="aiteam-inline-note">权限范围</div>' +
      '<div class="aiteam-stack">' + renderInvitePermissions() + '</div>' +
      '<label class="aiteam-inline-note">邀请留言</label>' +
      '<input class="aiteam-input" data-role="invite-message" value="" placeholder="可选：补充本次邀请说明" />' +
      '<div class="aiteam-action-row"><button type="button" class="aiteam-btn" data-role="create-admin-invite">发送邀请</button></div>' +
      '</div>' +
      renderInviteCards(invites) +
      '</div>' +
      '</section>';
  }

  function renderOtherSection(data) {
    var notificationPolicy = data && data.notification_policy ? data.notification_policy : {};
    var versionLabel = stringValue(data && data.version_label, '未设置');
    var versionNotesUrl = stringValue(data && data.version_notes_url, '');
    var helpDocUrl = stringValue(data && data.help_doc_url, '');
    var feedbackFormUrl = stringValue(data && data.feedback_form_url, '');
    return '' +
      '<section class="aiteam-panel">' +
      '<div class="aiteam-panel__header"><h3>其他设置</h3><span class="aiteam-inline-note">版本管理 / 帮助反馈 / 通知设置</span></div>' +
      '<div class="aiteam-stack">' +
      '<label class="aiteam-inline-note">当前版本</label>' +
      '<input class="aiteam-input" data-role="settings-version-label" value="' + esc(versionLabel) + '" placeholder="例如 v1.0.0" />' +
      '<label class="aiteam-inline-note">更新日志</label>' +
      '<input class="aiteam-input" data-role="settings-version-notes-url" value="' + esc(versionNotesUrl) + '" placeholder="请输入更新日志链接" />' +
      '<div class="aiteam-action-row">' +
      '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="check-version-updates">检查更新</button>' +
      (versionNotesUrl ? '<a class="aiteam-btn aiteam-btn--secondary" href="' + esc(versionNotesUrl) + '">更新日志</a>' : '') +
      '</div>' +
      '<label class="aiteam-inline-note">在线文档</label>' +
      '<input class="aiteam-input" data-role="settings-help-doc-url" value="' + esc(helpDocUrl) + '" placeholder="请输入帮助文档链接" />' +
      '<label class="aiteam-inline-note">帮助与反馈</label>' +
      '<input class="aiteam-input" data-role="settings-feedback-form-url" value="' + esc(feedbackFormUrl) + '" placeholder="请输入问题表单链接" />' +
      '<div class="aiteam-inline-note">通知设置</div>' +
      '<label class="aiteam-card__meta"><input type="checkbox" data-role="notify-employee-task-completed"' + (notificationPolicy.employee_task_completed ? ' checked' : '') + ' /><span>员工任务完成通知（' + boolLabel(notificationPolicy.employee_task_completed) + '）</span></label>' +
      '<label class="aiteam-card__meta"><input type="checkbox" data-role="notify-system-announcements"' + (notificationPolicy.system_announcements ? ' checked' : '') + ' /><span>系统公告（' + boolLabel(notificationPolicy.system_announcements) + '）</span></label>' +
      '<label class="aiteam-card__meta"><input type="checkbox" data-role="notify-low-balance-email"' + (notificationPolicy.low_balance_email ? ' checked' : '') + ' /><span>低余额邮件预警（' + boolLabel(notificationPolicy.low_balance_email) + '）</span></label>' +
      '<label class="aiteam-inline-note">低余额预警阈值（分）</label>' +
      '<input class="aiteam-input" data-role="settings-low-balance-threshold" type="number" min="0" step="100" value="' + esc(data && data.low_balance_threshold_cents != null ? String(data.low_balance_threshold_cents) : '5000') + '" />' +
      '<label class="aiteam-card__meta"><input type="checkbox" data-role="settings-warning-enabled"' + (data && data.warning_enabled ? ' checked' : '') + ' /><span>低余额预警总开关（' + boolLabel(data && data.warning_enabled) + '）</span></label>' +
      '<div class="aiteam-action-row"><button type="button" class="aiteam-btn" data-role="save-support-settings">保存通知与支持设置</button></div>' +
      '</div>' +
      '</section>';
  }

  function renderSettings(container, data, notice) {
    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
      '<h2 class="aiteam-shell__panel-title">企业设置</h2>' +
      '<p class="aiteam-shell__panel-body">通过 /api/team/settings 与 /api/enterprise-admin/invites 管理企业资料、邀请、帮助反馈与通知策略。</p>' +
      (notice ? '<div class="aiteam-state aiteam-state-empty"><p>' + esc(notice) + '</p></div>' : '') +
      '<div class="aiteam-grid aiteam-grid--settings">' +
      renderAccountSection(data) +
      renderAdminSection(data) +
      renderOtherSection(data) +
      '</div>' +
      '</div>';
  }

  function _query(container, selector) {
    return container && typeof container.querySelector === 'function' ? container.querySelector(selector) : null;
  }

  function _queryAll(container, selector) {
    return container && typeof container.querySelectorAll === 'function' ? container.querySelectorAll(selector) : [];
  }

  function _checked(node) {
    return !!(node && node.checked);
  }

  function buildProfilePayload(container) {
    return {
      name: stringValue(_query(container, '[data-role="settings-name"]') && _query(container, '[data-role="settings-name"]').value, ''),
      logo_url: stringValue(_query(container, '[data-role="settings-logo-url"]') && _query(container, '[data-role="settings-logo-url"]').value, ''),
      contact_phone: stringValue(_query(container, '[data-role="settings-contact-phone"]') && _query(container, '[data-role="settings-contact-phone"]').value, ''),
      contact_wechat: stringValue(_query(container, '[data-role="settings-contact-wechat"]') && _query(container, '[data-role="settings-contact-wechat"]').value, ''),
    };
  }

  function buildPreferencesPayload(container) {
    return {
      help_doc_url: stringValue(_query(container, '[data-role="settings-help-doc-url"]') && _query(container, '[data-role="settings-help-doc-url"]').value, ''),
      feedback_form_url: stringValue(_query(container, '[data-role="settings-feedback-form-url"]') && _query(container, '[data-role="settings-feedback-form-url"]').value, ''),
      version_label: stringValue(_query(container, '[data-role="settings-version-label"]') && _query(container, '[data-role="settings-version-label"]').value, ''),
      version_notes_url: stringValue(_query(container, '[data-role="settings-version-notes-url"]') && _query(container, '[data-role="settings-version-notes-url"]').value, ''),
      low_balance_threshold_cents: parseInteger(_query(container, '[data-role="settings-low-balance-threshold"]') && _query(container, '[data-role="settings-low-balance-threshold"]').value, 5000),
      warning_enabled: _checked(_query(container, '[data-role="settings-warning-enabled"]')),
      notification_policy: {
        employee_task_completed: _checked(_query(container, '[data-role="notify-employee-task-completed"]')),
        system_announcements: _checked(_query(container, '[data-role="notify-system-announcements"]')),
        low_balance_email: _checked(_query(container, '[data-role="notify-low-balance-email"]')),
      }
    };
  }

  function buildInvitePayload(container) {
    var permissions = {};
    var boxes = _queryAll(container, '[data-role="invite-permission"]');
    for (var i = 0; i < boxes.length; i++) {
      var key = boxes[i].getAttribute('data-permission-key');
      if (key) permissions[key] = !!boxes[i].checked;
    }
    return {
      phone: stringValue(_query(container, '[data-role="invite-phone"]') && _query(container, '[data-role="invite-phone"]').value, ''),
      role: stringValue(_query(container, '[data-role="invite-role"]') && _query(container, '[data-role="invite-role"]').value, 'enterprise_admin'),
      permissions: permissions,
      message: stringValue(_query(container, '[data-role="invite-message"]') && _query(container, '[data-role="invite-message"]').value, ''),
      idempotency_key: 'ui-admin-invite-create'
    };
  }

  function mergeSettingsData(settingsData, patch) {
    var next = Object.assign({}, settingsData || {}, patch || {});
    if (patch && patch.notification_policy) {
      next.notification_policy = Object.assign({}, settingsData && settingsData.notification_policy || {}, patch.notification_policy);
    }
    return next;
  }

  function bindSettingsActions(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return;

    var saveProfileButton = _query(container, '[data-role="save-profile-settings"]');
    if (saveProfileButton && typeof saveProfileButton.addEventListener === 'function') {
      saveProfileButton.addEventListener('click', function () {
        if (typeof container.lastProfileHandler === 'function') {
          container.lastProfileHandler(buildProfilePayload(container));
        }
      });
    }

    var saveSupportButton = _query(container, '[data-role="save-support-settings"]');
    if (saveSupportButton && typeof saveSupportButton.addEventListener === 'function') {
      saveSupportButton.addEventListener('click', function () {
        if (typeof container.lastPreferencesHandler === 'function') {
          container.lastPreferencesHandler(buildPreferencesPayload(container));
        }
      });
    }

    var inviteButton = _query(container, '[data-role="create-admin-invite"]');
    if (inviteButton && typeof inviteButton.addEventListener === 'function') {
      inviteButton.addEventListener('click', function () {
        if (typeof container.lastInviteHandler === 'function') {
          container.lastInviteHandler(buildInvitePayload(container));
        }
      });
    }

    var revokeButtons = _queryAll(container, '[data-role="revoke-admin-invite"]');
    for (var i = 0; i < revokeButtons.length; i++) {
      if (typeof revokeButtons[i].addEventListener === 'function') {
        revokeButtons[i].addEventListener('click', function () {
          var inviteId = this.getAttribute('data-invite-id');
          if (inviteId && typeof container.lastDeleteInviteHandler === 'function') {
            container.lastDeleteInviteHandler(inviteId);
          }
        });
      }
    }

    var checkUpdateButton = _query(container, '[data-role="check-version-updates"]');
    if (checkUpdateButton && typeof checkUpdateButton.addEventListener === 'function') {
      checkUpdateButton.addEventListener('click', function () {
        if (typeof container.lastVersionCheckHandler === 'function') {
          container.lastVersionCheckHandler();
        }
      });
    }
  }

  ns.pages.adminSettings = {
    init: function (container) {
      if (!container) return;

      container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载企业设置...</p></div>';

      var settingsData = null;

      function rerender(notice) {
        if (!settingsData) return;
        renderSettings(container, settingsData, notice || '');
        bindSettingsActions(container);
      }

      container.lastProfileHandler = function (payload) {
        return ns.api.patch('/api/team/settings', payload || {}).then(function (result) {
          if (result && result.ok) {
            settingsData = mergeSettingsData(settingsData, payload || {});
            rerender('企业资料已更新');
            return result;
          }
          rerender('企业资料更新失败');
          return result;
        });
      };

      container.lastPreferencesHandler = function (payload) {
        return ns.api.patch('/api/team/settings', payload || {}).then(function (result) {
          if (result && result.ok) {
            settingsData = mergeSettingsData(settingsData, payload || {});
            rerender('通知与支持设置已更新');
            return result;
          }
          rerender('通知与支持设置更新失败');
          return result;
        });
      };

      container.lastInviteHandler = function (payload) {
        return ns.api.post('/api/enterprise-admin/invites', payload || {}).then(function (result) {
          if (result && result.ok) {
            var invite = Object.assign({}, payload || {}, result.data || {});
            settingsData = Object.assign({}, settingsData || {});
            settingsData.admin_invites = (settingsData.admin_invites || []).concat([invite]);
            rerender('已发送新的管理员邀请');
            return result;
          }
          rerender('管理员邀请创建失败');
          return result;
        });
      };

      container.lastDeleteInviteHandler = function (inviteId) {
        return ns.api.delete('/api/enterprise-admin/invites/' + encodeURIComponent(inviteId)).then(function (result) {
          if (result && result.ok) {
            settingsData = Object.assign({}, settingsData || {});
            settingsData.admin_invites = (settingsData.admin_invites || []).filter(function (item) {
              return item.invite_id !== inviteId;
            });
            rerender('管理员邀请已撤销');
            return result;
          }
          rerender('管理员邀请撤销失败');
          return result;
        });
      };

      container.lastVersionCheckHandler = function () {
        rerender('已检查更新，请查看更新日志确认版本差异');
        return Promise.resolve({ ok: true });
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
        rerender('');
      });
    }
  };
}(window.aiteam));
