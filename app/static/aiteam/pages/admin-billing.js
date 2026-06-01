// admin-billing.js — L4-S04: Enterprise Admin billing/usage consumption shell
window.aiteam = window.aiteam || {};

(function registerAdminBillingPage(ns) {
  ns.pages = ns.pages || {};

  ns.pages.adminBilling = {
    init: function (container) {
      if (!container) return;

      container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载费用数据...</p></div>';

      ns.api.get('/api/enterprise-admin/billing/usage').then(function (result) {
        if (!result.ok) {
          if (result.status === 501) {
            container.innerHTML =
              '<div class="aiteam-shell__panel">' +
              '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
              '<h2 class="aiteam-shell__panel-title">费用总览</h2>' +
              '<p class="aiteam-shell__panel-body">费用 API 尚未实现（当前返回 501）。此区域将在后端就绪后展示消耗看板与排行。</p>' +
              '</div>';
            return;
          }
          if (ns.states && ns.states.handleApiResult) {
            ns.states.handleApiResult(result, container, function () {});
          } else {
            container.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>⚠ 费用数据加载失败</p></div>';
          }
          return;
        }
        container.innerHTML =
          '<div class="aiteam-shell__panel">' +
          '<h2 class="aiteam-shell__panel-title">费用总览</h2>' +
          '<p class="aiteam-shell__panel-body">通过 /api/enterprise-admin/billing/usage 消费企业费用数据。</p>' +
          '</div>';
      });
    },
  };
}(window.aiteam));
