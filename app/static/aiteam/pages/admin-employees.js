// admin-employees.js — enterprise employee list with governance UX + drawer entry
window.aiteam = window.aiteam || {};

(function registerAdminEmployeesPage(ns) {
  ns.pages = ns.pages || {};

  var _llmModels = [];
  var _modelsLoaded = false;

  // Cached enterprise resources for the creation modal multi-select pickers.
  var _enterpriseSkillInstalls = [];
  var _skillsLoaded = false;
  var _enterpriseKnowledgeBases = [];
  var _kbsLoaded = false;
  var _enterpriseConnectors = [];
  var _connectorsLoaded = false;

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

  function _modelOptions(models) {
    var opts = ['<option value="">默认（继承企业默认模型）</option>'];
    for (var i = 0; i < (models || []).length; i++) {
      var m = models[i] || {};
      var label = (m.provider_name || m.provider_key || '') + ' · ' + (m.label || m.model_id || '');
      opts.push('<option value="' + _esc(m.provider_key) + '|' + _esc(m.model_id) + '">' + _esc(label) + '</option>');
    }
    return opts.join('');
  }

  // Lazily load the enterprise model catalog once, then invoke cb. Cached on the
  // module so reopening the dialog does not refetch.
  function _ensureModels(cb) {
    if (_modelsLoaded || !ns.api || !ns.api.getLlmModels) { cb(); return; }
    ns.api.getLlmModels().then(function (result) {
      if (result && result.ok && result.data) _llmModels = result.data.models || [];
      _modelsLoaded = true;
      cb();
    }, function () { _modelsLoaded = true; cb(); });
  }

  function _ensureSkills(cb) {
    if (_skillsLoaded || !ns.api || !ns.api.getSkillInstalls) { cb(); return; }
    ns.api.getSkillInstalls().then(function (result) {
      if (result && result.ok && result.data) _enterpriseSkillInstalls = Array.isArray(result.data.items) ? result.data.items : [];
      _skillsLoaded = true;
      cb();
    }, function () { _skillsLoaded = true; cb(); });
  }

  function _ensureKbs(cb) {
    if (_kbsLoaded || !ns.api || !ns.api.getKnowledgeBases) { cb(); return; }
    ns.api.getKnowledgeBases().then(function (result) {
      if (result && result.ok && result.data) _enterpriseKnowledgeBases = Array.isArray(result.data.knowledge_bases) ? result.data.knowledge_bases : [];
      _kbsLoaded = true;
      cb();
    }, function () { _kbsLoaded = true; cb(); });
  }

  function _ensureConnectors(cb) {
    if (_connectorsLoaded || !ns.api || !ns.api.getConnectors) { cb(); return; }
    ns.api.getConnectors().then(function (result) {
      if (result && result.ok && result.data) _enterpriseConnectors = Array.isArray(result.data.connectors) ? result.data.connectors : [];
      _connectorsLoaded = true;
      cb();
    }, function () { _connectorsLoaded = true; cb(); });
  }

  function _renderCheckItems(label, items, nameKey, idKey, dataRole) {
    if (!items.length) return '<p class="aiteam-modal__meta">暂无可用' + _esc(label) + '</p>';
    return '<details class="aiteam-create-detail"><summary>' + _esc(label) + '（' + items.length + '）</summary>' +
      '<div class="aiteam-create-checkgroup">' + items.map(function (item) {
        var id = item[idKey] || '';
        var name = item[nameKey] || id || '';
        return '<label class="aiteam-drawer__check"><input type="checkbox" data-role="' + _esc(dataRole) + '" value="' + _esc(id) + '"> ' + _esc(name) + '</label>';
      }).join('') + '</div></details>';
  }

  function _refreshCapabilitiesSection(section) {
    if (!section) return;
    section.innerHTML =
      _renderCheckItems('技能', _enterpriseSkillInstalls, 'display_name', 'skill_code', 'create-skill-check') +
      _renderCheckItems('知识库', _enterpriseKnowledgeBases, 'name', 'knowledge_base_id', 'create-kb-check') +
      _renderCheckItems('连接器', _enterpriseConnectors, 'name', 'connector_id', 'create-connector-check');
  }

  function _renderCreateControls() {
    var skillsHtml = _skillsLoaded ? _renderCheckItems('技能', _enterpriseSkillInstalls, 'display_name', 'skill_code', 'create-skill-check') : '<p class="aiteam-modal__meta">加载技能库中...</p>';
    var kbsHtml = _kbsLoaded ? _renderCheckItems('知识库', _enterpriseKnowledgeBases, 'name', 'knowledge_base_id', 'create-kb-check') : '<p class="aiteam-modal__meta">加载知识库中...</p>';
    var connsHtml = _connectorsLoaded ? _renderCheckItems('连接器', _enterpriseConnectors, 'name', 'connector_id', 'create-connector-check') : '<p class="aiteam-modal__meta">加载连接器中...</p>';
    return '<div class="aiteam-action-row">' +
      '<button type="button" class="aiteam-btn" data-role="open-create-employee">+ 新建员工</button>' +
      '</div>' +
      '<div class="aiteam-modal__overlay" data-role="create-employee-modal" hidden>' +
      '<form class="aiteam-modal aiteam-employee-create" data-role="create-employee-form">' +
      '<h3 class="aiteam-modal__title">新建数字员工</h3>' +
      '<p class="aiteam-modal__sub">填写基础信息并选择模型/技能/知识库/连接器，创建即可生效。</p>' +
      '<label class="aiteam-field"><span>员工名称（必填）</span>' +
      '<input class="aiteam-input" name="display_name" placeholder="例如：产品分析助理" required /></label>' +
      '<label class="aiteam-field"><span>角色 / 岗位（可选）</span>' +
      '<input class="aiteam-input" name="role_name" placeholder="例如：产品顾问" /></label>' +
      '<label class="aiteam-field"><span>描述（可选）</span>' +
      '<textarea class="aiteam-input aiteam-textarea" name="description" rows="3" placeholder="简要描述员工职责与特长"></textarea></label>' +
      '<label class="aiteam-field"><span>模型（可选）</span>' +
      '<select class="aiteam-select" data-role="create-employee-model">' + _modelOptions(_llmModels) + '</select></label>' +
      '<label class="aiteam-field"><span>系统提示词（可选）</span>' +
      '<textarea class="aiteam-input aiteam-textarea" name="system_prompt" rows="5" placeholder="留空则使用默认人设"></textarea></label>' +
      '<div class="aiteam-create-capabilities" data-role="create-capabilities-section">' +
      skillsHtml + kbsHtml + connsHtml +
      '</div>' +
      '<div class="aiteam-action-row">' +
      '<button type="submit" class="aiteam-btn">创建</button>' +
      '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="cancel-create-employee">取消</button>' +
      '<span class="aiteam-inline-note" data-role="create-employee-notice"></span>' +
      '</div>' +
      '</form>' +
      '</div>';
  }

  function _bindEmployeeActions(container) {
    if (!container || typeof container.querySelector !== 'function') return;
    var openBtn = container.querySelector('[data-role="open-create-employee"]');
    var modal = container.querySelector('[data-role="create-employee-modal"]');
    var form = container.querySelector('[data-role="create-employee-form"]');
    var cancelBtn = container.querySelector('[data-role="cancel-create-employee"]');
    var notice = container.querySelector('[data-role="create-employee-notice"]');
    var modelSelect = container.querySelector('[data-role="create-employee-model"]');

    function closeModal() { if (modal) modal.hidden = true; }

    if (openBtn && modal) {
      openBtn.addEventListener('click', function () {
        modal.hidden = false;
        // Populate the model picker from the enterprise catalog on first open.
        _ensureModels(function () {
          if (modelSelect && !modelSelect.getAttribute('data-loaded')) {
            modelSelect.innerHTML = _modelOptions(_llmModels);
            modelSelect.setAttribute('data-loaded', '1');
          }
        });
        // Lazy-load enterprise skills, KBs, connectors for multi-select.
        var capsSection = container.querySelector('[data-role="create-capabilities-section"]');
        if (capsSection && capsSection.innerHTML.indexOf('create-skill-check') === -1) {
          _ensureSkills(function () { _refreshCapabilitiesSection(capsSection); });
          _ensureKbs(function () { _refreshCapabilitiesSection(capsSection); });
          _ensureConnectors(function () { _refreshCapabilitiesSection(capsSection); });
        }
        var nameInput = form && form.querySelector('[name="display_name"]');
        if (nameInput && nameInput.focus) nameInput.focus();
      });
    }
    if (cancelBtn) {
      cancelBtn.addEventListener('click', closeModal);
    }
    // Click on the dimmed backdrop (outside the dialog card) closes it.
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e && e.target === modal) closeModal();
      });
    }
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var displayName = String((form.display_name && form.display_name.value) || '').trim();
        if (!displayName) { if (notice) notice.textContent = '请填写员工名称'; return; }
        var payload = {
          display_name: displayName,
          role_name: String((form.role_name && form.role_name.value) || '').trim(),
        };
        var description = String((form.description && form.description.value) || '').trim();
        if (description) payload.description = description;
        var systemPrompt = String((form.system_prompt && form.system_prompt.value) || '').trim();
        if (systemPrompt) payload.system_prompt = systemPrompt;
        var modelValue = String((modelSelect && modelSelect.value) || '').trim();
        if (modelValue && modelValue.indexOf('|') !== -1) {
          var parts = modelValue.split('|');
          payload.model_provider = parts[0];
          payload.model_name = parts[1];
        }
        // Collect selected skills, KBs, connectors from checkboxes.
        var selectedSkills = [];
        var skillChecks = form.querySelectorAll('[data-role="create-skill-check"]:checked');
        for (var si = 0; si < skillChecks.length; si++) { selectedSkills.push(skillChecks[si].value); }
        if (selectedSkills.length) payload.skill_ids = selectedSkills;
        var selectedKbs = [];
        var kbChecks = form.querySelectorAll('[data-role="create-kb-check"]:checked');
        for (var ki = 0; ki < kbChecks.length; ki++) { selectedKbs.push(kbChecks[ki].value); }
        if (selectedKbs.length) payload.kb_ids = selectedKbs;
        var selectedConns = [];
        var connChecks = form.querySelectorAll('[data-role="create-connector-check"]:checked');
        for (var ci = 0; ci < connChecks.length; ci++) { selectedConns.push(connChecks[ci].value); }
        if (selectedConns.length) payload.connector_ids = selectedConns;
        if (notice) notice.textContent = '创建中...';
        ns.api.createEmployee(payload).then(function (result) {
          if (result && result.ok) {
            closeModal();
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
