// admin-employees.js — L4-S04: Enterprise Admin employee list consumption shell
window.aiteam = window.aiteam || {};

(function registerAdminEmployeesPage(ns) {
  ns.pages = ns.pages || {};

  ns.pages.adminEmployees = {
    init: function (container) {
      if (!container) return;

      container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载员工数据...</p></div>';

      ns.api.get('/api/enterprise-admin/employees').then(function (result) {
        if (!result.ok) {
          if (result.status === 501) {
            // Backend not yet implemented — still the correct northbound prefix
            container.innerHTML =
              '<div class="aiteam-shell__panel">' +
              '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
              '<h2 class="aiteam-shell__panel-title">员工管理</h2>' +
              '<p class="aiteam-shell__panel-body">企业管理员 API 尚未实现（当前返回 501）。此区域将在后端就绪后展示员工列表与状态筛选。</p>' +
              '</div>';
            return;
          }
          if (ns.states && ns.states.handleApiResult) {
            ns.states.handleApiResult(result, container, function () {});
          } else {
            container.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>⚠ 员工数据加载失败</p></div>';
          }
          return;
        }
        var data = result.data;
        if (!data || !data.employees || data.employees.length === 0) {
          if (ns.states && ns.states.renderEmpty) {
            ns.states.renderEmpty(container, '暂无员工数据');
          }
          return;
        }
        var rows = data.employees.map(function (e) {
          return '<tr><td>' + (e.employee_id || '') + '</td><td>' + (e.display_name || '') + '</td><td>' + (e.role_name || '') + '</td><td>' + (e.status || '') + '</td></tr>';
        }).join('');
        container.innerHTML =
          '<div class="aiteam-shell__panel">' +
          '<h2 class="aiteam-shell__panel-title">员工管理</h2>' +
          '<p class="aiteam-shell__panel-body">通过 /api/enterprise-admin/employees 消费企业员工列表。</p>' +
          '<table class="aiteam-table"><thead><tr><th>ID</th><th>名称</th><th>角色</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '</div>';
      });
    },
  };
}(window.aiteam));
