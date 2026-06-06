// system-health.js — L4-D2: System Admin health/finance with governance UX
window.aiteam = window.aiteam || {};

(function registerSystemHealthPage(ns) {
  ns.pages = ns.pages || {};

  function _renderPermissionDenied(container) {
    if (ns.states && ns.states.renderPermissionDenied) {
      ns.states.renderPermissionDenied(container);
    } else {
      container.innerHTML = '<div class="aiteam-state aiteam-state-denied"><p>您没有权限访问此内容</p></div>';
    }
  }

  ns.pages.systemHealth = {
    init: function (container) {
      if (!container) return;

      var role = ns.role ? ns.role.getActiveRole() : '';

      // System pages only accessible to system_admin or system_operator
      if (role && ns.role) {
        var isSystemRole = ns.role.hasPermission(role, 'system_read');
        if (!isSystemRole) {
          _renderPermissionDenied(container);
          return;
        }
      }

      if (ns.states && ns.states.renderLoading) {
        ns.states.renderLoading(container);
      } else {
        container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载系统健康数据...</p></div>';
      }

      ns.api.get('/api/system-admin/health').then(function (result) {
        if (!result.ok) {
          if (result.status === 501) {
            container.innerHTML =
              '<div class="aiteam-shell__panel">' +
              '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
              '<h2 class="aiteam-shell__panel-title">系统健康</h2>' +
              '<p class="aiteam-shell__panel-body">系统管理员 API 尚未实现（当前返回 501）。此区域将在后端就绪后展示平台健康状态与运营概览。</p>' +
              '</div>';
            return;
          }
          if (ns.states && ns.states.handleApiResult) {
            ns.states.handleApiResult(result, container, function () {});
          } else {
            container.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>⚠ 系统健康数据加载失败</p></div>';
          }
          return;
        }
        container.innerHTML =
          '<div class="aiteam-shell__panel">' +
          '<h2 class="aiteam-shell__panel-title">系统健康</h2>' +
          '<p class="aiteam-shell__panel-body">通过 /api/system-admin/health 消费平台健康数据。</p>' +
          '</div>';
      });
    },
  };
}(window.aiteam));
