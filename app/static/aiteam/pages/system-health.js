// system-health.js — L4-S04: System Admin health/finance consumption shell
window.aiteam = window.aiteam || {};

(function registerSystemHealthPage(ns) {
  ns.pages = ns.pages || {};

  ns.pages.systemHealth = {
    init: function (container) {
      if (!container) return;

      container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载系统健康数据...</p></div>';

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
