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

  function _esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _buildEmployeeRows(employees) {
    return employees.map(function (item) {
      var id = item.employee_id || '';
      return '<tr data-employee-id="' + _esc(id) + '" class="aiteam-employee-row">' +
        '<td>' + _esc(id) + '</td>' +
        '<td>' + _esc(item.display_name) + '</td>' +
        '<td>' + _esc(item.role_name) + '</td>' +
        '<td>' + _esc(item.status) + '</td>' +
        '<td><button type="button" class="aiteam-btn aiteam-btn--secondary aiteam-employee-del" ' +
        'data-role="delete-employee" data-employee-id="' + _esc(id) + '" ' +
        'data-employee-name="' + _esc(item.display_name || id) + '">删除</button></td>' +
        '</tr>';
    }).join('');
  }

  function _renderCreateControls() {
    return '<div class="aiteam-action-row">' +
      '<button type="button" class="aiteam-btn" data-role="open-create-employee">+ 新建员工</button>' +
      '</div>' +
      '<form class="aiteam-card aiteam-employee-create" data-role="create-employee-form" hidden>' +
      '<h3 class="aiteam-card__title">新建数字员工</h3>' +
      '<div class="aiteam-employee-create__grid">' +
      '<input class="aiteam-input" name="display_name" placeholder="员工名称（必填）" required />' +
      '<input class="aiteam-input" name="role_name" placeholder="角色 / 岗位（可选）" />' +
      '</div>' +
      '<p class="aiteam-card__meta">新建后会自动创建对应的 Hermes 运行档案，可在详情中继续配置模型、技能与知识。</p>' +
      '<div class="aiteam-action-row">' +
      '<button type="submit" class="aiteam-btn">创建</button>' +
      '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="cancel-create-employee">取消</button>' +
      '<span class="aiteam-inline-note" data-role="create-employee-notice"></span>' +
      '</div>' +
      '</form>';
  }

  function _bindEmployeeActions(container) {
    if (!container || typeof container.querySelector !== 'function') return;
    var openBtn = container.querySelector('[data-role="open-create-employee"]');
    var form = container.querySelector('[data-role="create-employee-form"]');
    var cancelBtn = container.querySelector('[data-role="cancel-create-employee"]');
    var notice = container.querySelector('[data-role="create-employee-notice"]');
    if (openBtn && form) {
      openBtn.addEventListener('click', function () {
        form.hidden = false;
        var nameInput = form.querySelector('[name="display_name"]');
        if (nameInput && nameInput.focus) nameInput.focus();
      });
    }
    if (cancelBtn && form) {
      cancelBtn.addEventListener('click', function () { form.hidden = true; });
    }
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var displayName = String((form.display_name && form.display_name.value) || '').trim();
        if (!displayName) { if (notice) notice.textContent = '请填写员工名称'; return; }
        var payload = { display_name: displayName, role_name: String((form.role_name && form.role_name.value) || '').trim() };
        if (notice) notice.textContent = '创建中...';
        ns.api.createEmployee(payload).then(function (result) {
          if (result && result.ok) {
            ns.pages.adminEmployees.init(container);
          } else if (notice) {
            notice.textContent = '创建失败：' + ((result && result.data && result.data.message) || (result && result.error) || '未知错误');
          }
        });
      });
    }

    var delButtons = container.querySelectorAll('[data-role="delete-employee"]');
    for (var i = 0; i < delButtons.length; i++) {
      delButtons[i].addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation(); // don't open the row drawer
        var employeeId = this.getAttribute('data-employee-id');
        var name = this.getAttribute('data-employee-name') || employeeId;
        if (!employeeId) return;
        if (typeof window !== 'undefined' && window.confirm && !window.confirm('确认删除员工「' + name + '」？该操作会归档其档案。')) return;
        var btn = this;
        btn.disabled = true;
        ns.api.deleteEmployee(employeeId).then(function (result) {
          if (result && result.ok) {
            ns.pages.adminEmployees.init(container);
          } else {
            btn.disabled = false;
            alert('删除失败：' + ((result && result.data && result.data.message) || (result && result.error) || '未知错误'));
          }
        });
      });
    }
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
        var createControls = _renderCreateControls();
        var rows = _buildEmployeeRows(data.employees);

        container.innerHTML =
          '<div class="aiteam-shell__panel">' +
          '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
          '<h2 class="aiteam-shell__panel-title">员工管理</h2>' +
          '<p class="aiteam-shell__panel-body">管理企业的全部数字员工。点击员工行可进入详情，配置模型与提示词、授权技能、绑定知识库与连接器、管理记忆和周期任务。</p>' +
          createControls +
          exportBtn +
          '<table class="aiteam-table"><thead><tr><th>ID</th><th>名称</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          auditLink +
          '</div>';

        _bindAuditPanel(container);
        _bindEmployeeActions(container);
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
