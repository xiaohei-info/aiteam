// admin-employees.js — enterprise employee list with governance UX + drawer entry
window.aiteam = window.aiteam || {};

(function registerAdminEmployeesPage(ns) {
  ns.pages = ns.pages || {};

  function ensureDrawerModule(done) {
    if (ns.pages && ns.pages.adminEmployeeDrawer) {
      done();
      return;
    }
    if (typeof document === 'undefined' || !document.createElement || !document.head) {
      done();
      return;
    }
    var scriptEl = document.createElement('script');
    scriptEl.src = 'static/aiteam/pages/admin-employee-drawer.js';
    scriptEl.onload = done;
    scriptEl.onerror = done;
    document.head.appendChild(scriptEl);
  }

  function bindDrawer(container) {
    var drawer = ns.pages && ns.pages.adminEmployeeDrawer;
    if (!drawer) return;
    drawer.init(container);

    var rows = container.querySelectorAll('.aiteam-employee-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener('click', function () {
        var employeeId = this.getAttribute('data-employee-id');
        if (employeeId) drawer.open(employeeId);
      });
    }
  }

  function _renderPermissionDenied(container) {
    if (ns.states && ns.states.renderPermissionDenied) {
      ns.states.renderPermissionDenied(container);
    } else {
      container.innerHTML = '<div class="aiteam-state aiteam-state-denied"><p>您没有权限访问此内容</p></div>';
    }
  }

  function _renderExportButton(role) {
    if (!role || !ns.role || !ns.role.canExportEmployees(role)) return '';
    return (
      '<button class="aiteam-btn aiteam-btn--export" onclick="aiteam.pages.adminEmployees._exportEmployees()">' +
      '导出员工列表</button>'
    );
  }

  function _renderAuditLink(role) {
    if (!role || !ns.role || !ns.role.canViewAudit(role)) return '';
    return (
      '<p class="aiteam-shell__meta"><a href="/api/team/audit-events" class="aiteam-shell__link">' +
      '查看审计日志 →</a></p>'
    );
  }

  function _buildEmployeeRows(employees) {
    return employees.map(function (item) {
      return '<tr data-employee-id="' + (item.employee_id || '') + '" class="aiteam-employee-row">' +
        '<td>' + (item.employee_id || '') + '</td>' +
        '<td>' + (item.display_name || '') + '</td>' +
        '<td>' + (item.role_name || '') + '</td>' +
        '<td>' + (item.status || '') + '</td>' +
        '</tr>';
    }).join('');
  }

  ns.pages.adminEmployees = {
    init: function (container) {
      if (!container) return;

      var role = ns.role ? ns.role.getActiveRole() : '';
      if (role === 'finance_admin' || role === 'member') {
        _renderPermissionDenied(container);
        return;
      }

      if (ns.states && ns.states.renderLoading) {
        ns.states.renderLoading(container);
      } else {
        container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载员工数据...</p></div>';
      }

      ns.api.getEmployees().then(function (result) {
        if (!result.ok) {
          if (result.status === 501) {
            container.innerHTML =
              '<div class="aiteam-shell__panel">' +
              '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
              '<h2 class="aiteam-shell__panel-title">员工管理</h2>' +
              '<p class="aiteam-shell__panel-body">员工 API 尚未实现（当前返回 501）。后端就绪后，此区域将通过 /api/team/employees 与 /api/team/employees/{id} 展示员工列表、技能授权入口与导出能力。</p>' +
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

        var exportBtn = _renderExportButton(role);
        var auditLink = _renderAuditLink(role);
        var rows = _buildEmployeeRows(data.employees);

        container.innerHTML =
          '<div class="aiteam-shell__panel">' +
          '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
          '<h2 class="aiteam-shell__panel-title">员工管理</h2>' +
          '<p class="aiteam-shell__panel-body">通过 /api/team/employees 消费员工列表；点击员工行可查看 /api/team/employees/{id} 返回的技能配置，并用 skills_add / skills_remove 完成授权变更。</p>' +
          exportBtn +
          '<table class="aiteam-table"><thead><tr><th>ID</th><th>名称</th><th>角色</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          auditLink +
          '</div>';

        ensureDrawerModule(function () {
          bindDrawer(container);
        });
      });
    },

    // Export handler — calls canonical backend export path
    // NOTE: Backend /api/team/employees/export may still return 501 until rollout completes.
    _exportEmployees: function () {
      var role = ns.role ? ns.role.getActiveRole() : '';
      if (!ns.role || !ns.role.canExportEmployees(role)) {
        alert('您没有导出员工数据的权限');
        return;
      }
      ns.api.get('/api/team/employees/export').then(function (result) {
        if (result.ok) {
          alert('导出完成: ' + JSON.stringify(result.data));
        } else {
          alert('导出失败: ' + (result.error || '未知错误'));
        }
      });
    },
  };
}(window.aiteam));
