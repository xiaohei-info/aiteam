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

  function _parseEmployeeDetailPath(pathname) {
    var parts = String(pathname || '').split('/').filter(Boolean);
    if (parts.length < 3 || parts[0] !== 'admin' || parts[1] !== 'employees') return null;
    return {
      employeeId: decodeURIComponent(parts[2] || ''),
      tab: parts[3] ? decodeURIComponent(parts[3]) : ''
    };
  }

  function _pushEmployeeDetailPath(employeeId, tab) {
    if (!employeeId || typeof window === 'undefined') return;
    var nextPath = '/admin/employees/' + encodeURIComponent(employeeId) + (tab ? '/' + encodeURIComponent(tab) : '');
    if (window.history && window.history.pushState) {
      window.history.pushState({}, '', nextPath);
    } else if (window.location) {
      window.location.pathname = nextPath;
    }
  }

  function bindDrawer(container) {
    var drawer = ns.pages && ns.pages.adminEmployeeDrawer;
    if (!drawer) return;
    drawer.init(container);

    var rows = container.querySelectorAll('.aiteam-employee-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener('click', function () {
        var employeeId = this.getAttribute('data-employee-id');
        if (employeeId) {
          _pushEmployeeDetailPath(employeeId);
          drawer.open(employeeId);
        }
      });
    }

    var detailRoute = _parseEmployeeDetailPath(window.location && window.location.pathname);
    if (detailRoute && detailRoute.employeeId) {
      drawer.open(detailRoute.employeeId, { tab: detailRoute.tab, syncUrl: false });
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
    if (role && ns.role && !ns.role.canExportEmployees(role)) return '';
    return (
      '<button class="aiteam-btn aiteam-btn--export" onclick="aiteam.pages.adminEmployees._exportEmployees()">' +
      '导出员工列表</button>'
    );
  }

  function _renderAuditLink(role) {
    if (role && ns.role && !ns.role.canViewAudit(role)) return '';
    return (
      '<div class="aiteam-shell__meta">' +
      '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="toggle-audit">查看审计日志</button>' +
      '</div>' +
      '<div data-role="audit-panel" hidden></div>'
    );
  }

  function _formatAuditTime(value) {
    var text = String(value || '');
    return text ? text.slice(0, 19).replace('T', ' ') : '';
  }

  function _renderAuditTable(items) {
    if (!items || !items.length) {
      return '<p class="aiteam-shell__panel-body">暂无审计记录。</p>';
    }
    var rows = items.map(function (item) {
      return '<tr>' +
        '<td>' + _formatAuditTime(item.created_at) + '</td>' +
        '<td>' + (item.event_type || '') + '</td>' +
        '<td>' + (item.actor_id || '') + '</td>' +
        '<td>' + (item.target_type || '') + (item.target_id ? ' · ' + item.target_id : '') + '</td>' +
        '</tr>';
    }).join('');
    return '<table class="aiteam-table"><thead><tr><th>时间</th><th>事件</th><th>操作者</th><th>对象</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function _bindAuditPanel(container) {
    if (!container || typeof container.querySelector !== 'function') return;
    var toggle = container.querySelector('[data-role="toggle-audit"]');
    var panel = container.querySelector('[data-role="audit-panel"]');
    if (!toggle || !panel) return;
    toggle.addEventListener('click', function () {
      if (!panel.hidden) {
        panel.hidden = true;
        return;
      }
      panel.hidden = false;
      panel.innerHTML = '<p class="aiteam-shell__panel-body">加载审计日志...</p>';
      ns.api.get('/api/team/audit-events?limit=20').then(function (result) {
        if (!result.ok) {
          panel.innerHTML = '<p class="aiteam-shell__panel-body">审计日志加载失败，请稍后重试。</p>';
          return;
        }
        panel.innerHTML = _renderAuditTable(result.data && result.data.items);
      });
    });
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
              '<p class="aiteam-shell__panel-body">员工服务暂时不可用，请稍后刷新重试。</p>' +
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
          '<p class="aiteam-shell__panel-body">管理企业的全部数字员工。点击员工行可进入详情，配置模型与提示词、授权技能、绑定知识库与连接器、管理记忆和周期任务。</p>' +
          exportBtn +
          '<table class="aiteam-table"><thead><tr><th>ID</th><th>名称</th><th>角色</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          auditLink +
          '</div>';

        _bindAuditPanel(container);
        ensureDrawerModule(function () {
          bindDrawer(container);
        });
      });
    },

    _exportEmployees: function () {
      var role = ns.role ? ns.role.getActiveRole() : '';
      if (role && ns.role && !ns.role.canExportEmployees(role)) {
        alert('您没有导出员工数据的权限');
        return;
      }
      ns.api.downloadCsv('/api/team/employees/export', 'employees.csv').catch(function () {
        alert('导出失败，请稍后重试');
      });
    },
  };
}(window.aiteam));
