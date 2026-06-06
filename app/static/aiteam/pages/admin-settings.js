window.aiteam = window.aiteam || {};

(function registerAdminSettingsPage(ns) {
  ns.pages = ns.pages || {};

  function renderNotImplemented(container) {
    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
      '<h2 class="aiteam-shell__panel-title">企业设置</h2>' +
      '<p class="aiteam-shell__panel-body">设置 API 尚未实现（当前返回 501）。此区域将在后端就绪后展示企业资料、子管理员与邀请码配置。</p>' +
      '</div>';
  }

  function renderList(title, values, emptyMessage) {
    if (!values || !values.length) {
      return '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">' + title + '</span><span class="aiteam-shell__meta-value">' + emptyMessage + '</span></div>';
    }
    return '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">' + title + '</span><ul class="aiteam-shell__list">' + values.map(function (value) {
      return '<li>' + value + '</li>';
    }).join('') + '</ul></div>';
  }

  function renderSettings(container, data, notice) {
    var notificationPolicy = data && data.notification_policy ? data.notification_policy : {};
    var subAdmins = data && data.sub_admins ? data.sub_admins : [];
    var invites = data && data.invites ? data.invites : [];
    var policyRows = [
      '任务完成通知：' + (notificationPolicy.on_task_done ? '开启' : '关闭'),
      '余额预警通知：' + (notificationPolicy.on_low_balance ? '开启' : '关闭'),
      '系统公告通知：' + (notificationPolicy.on_system_notice ? '开启' : '关闭')
    ];

    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
      '<h2 class="aiteam-shell__panel-title">企业设置</h2>' +
      '<p class="aiteam-shell__panel-body">通过 /api/team/settings 与 /api/team/settings/admin-invites 管理企业资料、子管理员和邀请码。</p>' +
      (notice ? '<div class="aiteam-state aiteam-state-empty"><p>' + notice + '</p></div>' : '') +
      '<div class="aiteam-shell__meta">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">企业名称</span><span class="aiteam-shell__meta-value">' + (data.enterprise_name || '未设置') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">联系邮箱</span><span class="aiteam-shell__meta-value">' + (data.contact_email || '未设置') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">Logo</span><span class="aiteam-shell__meta-value">' + (data.logo_url || '未设置') + '</span></div>' +
      renderList('通知策略', policyRows, '未设置') +
      renderList('子管理员', subAdmins.map(function (admin) {
        return (admin.display_name || admin.user_id || '未命名') + '（' + (admin.role || 'unknown') + '）';
      }), '暂无子管理员') +
      renderList('邀请码', invites.map(function (invite) {
        return (invite.invite_code || invite.invite_id || '未生成') + '（' + (invite.role || 'member') + ' / ' + (invite.status || 'unknown') + '）';
      }), '暂无邀请码') +
      '</div>' +
      '</div>';
  }

  ns.pages.adminSettings = {
    init: function (container) {
      if (!container) return;

      container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载企业设置...</p></div>';

      var settingsData = null;

      function refreshNotice(message) {
        if (settingsData) {
          renderSettings(container, settingsData, message);
        }
      }

      container.lastPatchHandler = function (payload) {
        return ns.api.patch('/api/team/settings', payload || {}).then(function (result) {
          if (result && result.ok) {
            settingsData = Object.assign({}, settingsData || {}, payload || {});
            refreshNotice('企业设置已提交更新');
            return;
          }
          refreshNotice('企业设置更新失败');
        });
      };

      container.lastInviteHandler = function (payload) {
        return ns.api.post('/api/team/settings/admin-invites', payload || {}).then(function (result) {
          if (result && result.ok) {
            var invite = result.data || payload || {};
            settingsData = Object.assign({}, settingsData || {});
            settingsData.invites = (settingsData.invites || []).concat([invite]);
            refreshNotice('已生成新的管理员邀请');
            return;
          }
          refreshNotice('管理员邀请创建失败');
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
      });
    }
  };
}(window.aiteam));
