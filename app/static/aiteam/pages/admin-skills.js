// admin-skills.js — B02 skill market and install shell
window.aiteam = window.aiteam || {};

(function registerAdminSkillsPage(ns) {
  ns.pages = ns.pages || {};

  function renderPermissionDenied(container) {
    if (!container) return;
    if (ns.states && ns.states.renderPermissionDenied) {
      ns.states.renderPermissionDenied(container);
      return;
    }
    container.innerHTML = '<div class="aiteam-state aiteam-state-denied"><p>您没有权限访问此内容</p></div>';
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function stringValue(value, fallback) {
    if (value == null || value === '') return fallback || '';
    return String(value);
  }

  function normalizeItems(data) {
    if (!data) return [];
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.installs)) return data.installs;
    if (Array.isArray(data.skills)) return data.skills;
    return [];
  }

  function normalizeInstall(item) {
    var grants = Array.isArray(item && item.grants) ? item.grants.slice() : [];
    var grantedEmployeeIds = Array.isArray(item && item.granted_employee_ids)
      ? item.granted_employee_ids.slice()
      : grants.map(function (grant) { return grant && grant.employee_id ? String(grant.employee_id) : ''; }).filter(Boolean);
    return {
      install_id: stringValue(item && item.install_id, ''),
      skill_id: stringValue(item && (item.skill_id || item.skill_code), ''),
      name: stringValue(item && (item.name || item.display_name), item && (item.skill_id || item.skill_code) || '未命名技能'),
      version: stringValue(item && item.version, '—'),
      source: stringValue(item && (item.source || item.source_marketplace), 'custom'),
      visibility: stringValue(item && (item.visibility || item.scope_mode), 'enterprise'),
      scope_mode: stringValue(item && item.scope_mode, 'selected_employees'),
      granted_employee_ids: grantedEmployeeIds,
      grants: grants,
      updated_at: stringValue(item && (item.updated_at || item.installed_at), ''),
      latest_version: stringValue(item && item.latest_version, ''),
      update_available: !!(item && item.update_available),
      audit_status: stringValue(item && item.audit_status, ''),
      install_status: stringValue(item && item.install_status, item && item.update_available ? 'update_available' : 'active'),
    };
  }

  function normalizeCatalogItem(item) {
    return {
      skill_id: stringValue(item && (item.skill_id || item.skill_code), ''),
      name: stringValue(item && item.name, item && (item.skill_id || item.skill_code) || '未命名技能'),
      description: stringValue(item && item.description, '暂无描述'),
      source: stringValue(item && item.source, 'custom'),
      version: stringValue(item && item.version, '—'),
      latest_version: stringValue(item && item.latest_version, ''),
      install_count: Number(item && item.install_count) || 0,
      tags: Array.isArray(item && item.tags) ? item.tags.slice() : [],
      category: stringValue(item && item.category, ''),
      authorization_scope: stringValue(item && item.authorization_scope, ''),
      update_available: !!(item && item.update_available),
    };
  }

  function sourceLabel(source) {
    var value = stringValue(source, '').toLowerCase();
    if (value === 'clawhub') return 'clawhub.io';
    if (value === 'skillhub') return 'skillhub.io';
    return value || 'custom';
  }

  function installedLookup(installs) {
    var lookup = {};
    (installs || []).forEach(function (item) {
      if (item && item.skill_id) lookup[item.skill_id] = item;
    });
    return lookup;
  }

  function buildQueryText(item) {
    return [item.name, item.description, item.skill_id, item.category].concat(item.tags || []).join(' ').toLowerCase();
  }

  function filterCatalog(catalog, query) {
    var needle = stringValue(query, '').trim().toLowerCase();
    if (!needle) return catalog.slice();
    return catalog.filter(function (item) {
      return buildQueryText(item).indexOf(needle) !== -1;
    });
  }

  function apiErrorMessage(result) {
    if (result && result.status === 403) return '您没有权限访问技能市场';
    if (result && result.status === 404) return '技能市场暂时不可用';
    if (result && result.status === 501) return '技能市场暂时不可用';
    if (result && result.error) return result.error;
    if (result && typeof result.status !== 'undefined') return '请求失败 (' + result.status + ')';
    return '网络请求失败';
  }

  function renderInstallCard(item, state) {
    var grants = Array.isArray(item.granted_employee_ids) ? item.granted_employee_ids.length : 0;
    var versionLine = item.update_available && item.latest_version
      ? '版本 ' + esc(item.version) + ' → ' + esc(item.latest_version)
      : '版本 ' + esc(item.version) + ' · 来源 ' + esc(item.source);
    var auditLine = item.audit_status
      ? '<div class="aiteam-skill-card__meta">审计状态：' + esc(item.audit_status) + '</div>'
      : '<div class="aiteam-skill-card__meta">审计状态：暂缺</div>';
    var updatedLine = item.updated_at
      ? '<div class="aiteam-skill-card__meta">最近安装时间：' + esc(item.updated_at) + '</div>'
      : '';
    var scopeLine = item.scope_mode === 'all_employees'
      ? '授权范围：全员可见'
      : '授权员工：' + esc((item.granted_employee_ids || []).join(', ') || '尚未选择');
    var pending = item.install_id && item.install_id === state.pendingInstallId ? ' disabled' : '';
    var upgradeButton = item.update_available && item.latest_version && item.latest_version !== item.version
      ? '<button type="button" class="aiteam-btn" data-role="upgrade-skill-install" data-install-id="' + esc(item.install_id) + '">升级到最新</button>'
      : '<button type="button" class="aiteam-btn aiteam-btn--secondary" disabled>已是最新版本</button>';
    return '<li class="aiteam-skill-card">' +
      '<div class="aiteam-skill-card__title">' + esc(item.name) + '</div>' +
      '<div class="aiteam-skill-card__meta">' + versionLine + '</div>' +
      '<div class="aiteam-skill-card__meta">来源：' + esc(sourceLabel(item.source)) + '</div>' +
      '<div class="aiteam-skill-card__meta">可见性：' + esc(item.visibility) + ' · 已授权员工：' + esc(grants) + '</div>' +
      '<div class="aiteam-skill-card__meta">' + scopeLine + '</div>' +
      updatedLine +
      auditLine +
      '<div class="aiteam-skill-card__actions">' +
      upgradeButton +
      '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="grant-all-skill-install" data-install-id="' + esc(item.install_id) + '"' + pending + '>授权全员</button>' +
      '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="edit-skill-scope" data-install-id="' + esc(item.install_id) + '"' + pending + '>编辑授权员工</button>' +
      '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="uninstall-skill-install" data-install-id="' + esc(item.install_id) + '"' + pending + '>卸载技能</button>' +
      '</div>' +
      '</li>';
  }

  function renderCatalogCard(item, installsById, state) {
    var installed = item && item.skill_id && installsById[item.skill_id];
    var buttonLabel = installed ? '已安装到企业' : '安装到企业';
    var buttonClass = installed ? 'aiteam-btn aiteam-btn--secondary' : 'aiteam-btn';
    var disabled = installed || state.pendingSkillId === item.skill_id ? ' disabled' : '';
    var actionHint = item.authorization_scope
      ? '<div class="aiteam-skill-card__meta">授权范围：' + esc(item.authorization_scope) + '</div>'
      : '<div class="aiteam-skill-card__meta">授权范围：安装后在员工详情中通过 skills_add / skills_remove 控制</div>';
    var versionHint = item.update_available && item.latest_version
      ? '版本 ' + esc(item.version) + ' · 最新 ' + esc(item.latest_version)
      : '来源：' + esc(item.source) + ' · 版本 ' + esc(item.version) + ' · 企业安装数 ' + esc(item.install_count);
    return '<li class="aiteam-skill-card">' +
      '<div class="aiteam-skill-card__title">' + esc(item.name) + '</div>' +
      '<div class="aiteam-skill-card__meta">' + esc(item.description) + '</div>' +
      '<div class="aiteam-skill-card__meta">来源标注：' + esc(sourceLabel(item.source)) + '</div>' +
      '<div class="aiteam-skill-card__meta">' + versionHint + '</div>' +
      '<div class="aiteam-skill-card__meta">标签：' + esc((item.tags || []).join(' / ') || '无') + '</div>' +
      actionHint +
      '<div class="aiteam-skill-card__actions">' +
      '<button type="button" class="' + buttonClass + '" data-role="install-skill" data-skill-id="' + esc(item.skill_id) + '"' + disabled + '>' + buttonLabel + '</button>' +
      '</div>' +
      '</li>';
  }

  function createPageController(container) {
    var state = {
      installs: [],
      catalog: [],
      query: '',
      pendingSkillId: '',
      pendingInstallId: '',
      notices: [],
      loadState: {
        installs: 'loading',
        catalog: 'loading'
      },
      installScopeMode: 'all_employees',
      installScopeEmployeeIds: []
    };

    function setNotice(message) {
      state.notices = message ? [message] : [];
    }

    function buildDegradationNotes() {
      var notices = state.notices.slice();
      if (state.loadState.installs !== 'ready') {
        notices.push('已安装技能列表暂时无法加载，请稍后刷新重试。');
      }
      if (state.loadState.catalog !== 'ready') {
        notices.push('技能市场目录暂时无法加载，请稍后刷新重试。');
      }
      return notices;
    }

    function filteredCatalog() {
      return filterCatalog(state.catalog, state.query);
    }

    function setInstallScope(scopeMode, employeeIds) {
      state.installScopeMode = scopeMode === 'selected_employees' ? 'selected_employees' : 'all_employees';
      state.installScopeEmployeeIds = Array.isArray(employeeIds) ? employeeIds.slice() : [];
      render();
    }

    function bindEvents() {
      if (!container || !container.querySelectorAll) return;
      var searchInput = container.querySelector('[data-role="skills-search"]');
      if (searchInput) {
        searchInput.addEventListener('input', function () {
          state.query = this.value || '';
          render();
        });
      }
      var scopeModeButtons = container.querySelectorAll('[data-role="install-scope-mode"]');
      for (var h = 0; h < scopeModeButtons.length; h++) {
        scopeModeButtons[h].addEventListener('click', function () {
          setInstallScope(this.getAttribute('data-scope-mode'), state.installScopeEmployeeIds);
        });
      }
      var scopeInput = container.querySelector('[data-role="install-scope-employees"]');
      if (scopeInput) {
        scopeInput.addEventListener('input', function () {
          var employeeIds = String(this.value || '').split(',').map(function (item) {
            return item.replace(/^\s+|\s+$/g, '');
          }).filter(Boolean);
          state.installScopeEmployeeIds = employeeIds;
        });
      }
      var buttons = container.querySelectorAll('[data-role="install-skill"]');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].addEventListener('click', function () {
          installSkill(this.getAttribute('data-skill-id'));
        });
      }
      var upgradeButtons = container.querySelectorAll('[data-role="upgrade-skill-install"]');
      for (var j = 0; j < upgradeButtons.length; j++) {
        upgradeButtons[j].addEventListener('click', function () {
          upgradeInstall(this.getAttribute('data-install-id'));
        });
      }
      var grantAllButtons = container.querySelectorAll('[data-role="grant-all-skill-install"]');
      for (var k = 0; k < grantAllButtons.length; k++) {
        grantAllButtons[k].addEventListener('click', function () {
          updateScope(this.getAttribute('data-install-id'), 'all_employees', []);
        });
      }
      var scopeButtons = container.querySelectorAll('[data-role="edit-skill-scope"]');
      for (var m = 0; m < scopeButtons.length; m++) {
        scopeButtons[m].addEventListener('click', function () {
          var installId = this.getAttribute('data-install-id');
          var install = findInstallById(installId);
          var initial = install && install.granted_employee_ids ? install.granted_employee_ids.join(',') : '';
          var typed = typeof window.prompt === 'function'
            ? window.prompt('请输入授权员工 ID，多个用英文逗号分隔', initial)
            : initial;
          if (typed == null) return;
          var employeeIds = String(typed || '').split(',').map(function (item) {
            return item.replace(/^\s+|\s+$/g, '');
          }).filter(function (item) { return !!item; });
          updateScope(installId, 'selected_employees', employeeIds);
        });
      }
      var uninstallButtons = container.querySelectorAll('[data-role="uninstall-skill-install"]');
      for (var n = 0; n < uninstallButtons.length; n++) {
        uninstallButtons[n].addEventListener('click', function () {
          uninstallInstall(this.getAttribute('data-install-id'));
        });
      }
    }

    function findInstallById(installId) {
      for (var i = 0; i < state.installs.length; i++) {
        if (state.installs[i].install_id === installId) return state.installs[i];
      }
      return null;
    }

    function upsertInstall(installPatch) {
      var nextInstall = normalizeInstall(installPatch || {});
      var next = [];
      var replaced = false;
      for (var i = 0; i < state.installs.length; i++) {
        if (state.installs[i].install_id === nextInstall.install_id) {
          next.push(normalizeInstall(Object.assign({}, state.installs[i], nextInstall)));
          replaced = true;
        } else {
          next.push(state.installs[i]);
        }
      }
      if (!replaced) next.unshift(nextInstall);
      state.installs = next;
    }

    function render() {
      var installsById = installedLookup(state.installs);
      var visibleCatalog = filteredCatalog();
      var installedMarkup = state.installs.length
        ? state.installs.map(function (item) { return renderInstallCard(item, state); }).join('')
        : '<li class="aiteam-skill-card"><div class="aiteam-skill-card__meta">企业技能库暂无已安装技能</div></li>';
      var catalogMarkup = visibleCatalog.length
        ? visibleCatalog.map(function (item) { return renderCatalogCard(item, installsById, state); }).join('')
        : '<li class="aiteam-skill-card"><div class="aiteam-skill-card__meta">当前筛选条件下暂无可展示技能</div></li>';
      var notices = buildDegradationNotes();
      container.innerHTML =
        '<div class="aiteam-shell__panel">' +
        '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
        '<h2 class="aiteam-shell__panel-title">技能市场</h2>' +
        '<p class="aiteam-shell__panel-body">浏览技能市场并为企业安装技能。已安装技能支持升级、卸载与授权范围调整；安装后可在员工详情中为具体员工授权。</p>' +
        '<div class="aiteam-skill-summary">' +
        '<span class="aiteam-skill-summary__item">已安装 ' + esc(state.installs.length) + ' 项</span>' +
        '<span class="aiteam-skill-summary__item">市场可见 ' + esc(visibleCatalog.length) + ' 项</span>' +
        '<span class="aiteam-skill-summary__item">员工授权入口：员工详情抽屉</span>' +
        '</div>' +
        '<div class="aiteam-card aiteam-card--flat">' +
        '<div class="aiteam-card__row"><strong>安装时配置授权范围</strong><span class="aiteam-inline-note">全企业共享 / 仅指定员工可用</span></div>' +
        '<div class="aiteam-action-row">' +
        '<button type="button" class="aiteam-btn' + (state.installScopeMode === 'all_employees' ? '' : ' aiteam-btn--secondary') + '" data-role="install-scope-mode" data-scope-mode="all_employees">全企业共享</button>' +
        '<button type="button" class="aiteam-btn' + (state.installScopeMode === 'selected_employees' ? '' : ' aiteam-btn--secondary') + '" data-role="install-scope-mode" data-scope-mode="selected_employees">仅指定员工可用</button>' +
        '</div>' +
        '<div class="aiteam-card__meta"><span>员工 ID</span><span>' +
        '<input class="aiteam-input" data-role="install-scope-employees" value="' + esc(state.installScopeEmployeeIds.join(', ')) + '" placeholder="emp_1, emp_2">' +
        '</span></div>' +
        '</div>' +
        '<label class="aiteam-skills-search-wrap">' +
        '<span class="aiteam-shell__panel-body">搜索技能名称、描述或标签</span>' +
        '<input class="aiteam-skills-search" data-role="skills-search" type="search" value="' + esc(state.query) + '" placeholder="例如：搜索 / 表格 / 分析">' +
        '</label>' +
        '<div class="aiteam-skill-notices">' + notices.map(function (message) {
          return '<p class="aiteam-skill-notice">' + esc(message) + '</p>';
        }).join('') + '</div>' +
        '<div class="aiteam-skills-grid">' +
        '<section class="aiteam-skills-column"><h3>已安装技能</h3><ul class="aiteam-skills-list">' + installedMarkup + '</ul></section>' +
        '<section class="aiteam-skills-column"><h3>市场浏览</h3><ul class="aiteam-skills-list">' + catalogMarkup + '</ul></section>' +
        '</div>' +
        '</div>';
      bindEvents();
    }

    function installSkill(skillId) {
      if (!skillId || !ns.api || !ns.api.installSkill || state.pendingSkillId) return;
      var catalogItem = state.catalog.find(function (entry) { return entry.skill_id === skillId; });
      var payload = {
        skill_code: skillId,
        scope_mode: state.installScopeMode,
      };
      if (state.installScopeMode === 'selected_employees') {
        payload.employee_ids = state.installScopeEmployeeIds.slice();
      }
      state.pendingSkillId = skillId;
      setNotice('正在安装技能：' + skillId);
      render();
      ns.api.installSkill(payload).then(function (result) {
        state.pendingSkillId = '';
        if (!result.ok) {
          setNotice('技能安装失败：' + apiErrorMessage(result));
          render();
          return;
        }
        var nextInstall = normalizeInstall(result.data || {
          skill_id: skillId,
          name: catalogItem ? catalogItem.name : skillId,
          version: catalogItem ? catalogItem.version : '—',
          source: catalogItem ? catalogItem.source : 'custom',
          visibility: state.installScopeMode,
          scope_mode: state.installScopeMode,
          granted_employee_ids: state.installScopeMode === 'selected_employees' ? state.installScopeEmployeeIds.slice() : []
        });
        state.installs = state.installs.filter(function (item) {
          return item.skill_id !== nextInstall.skill_id;
        });
        state.installs.push(nextInstall);
        state.loadState.installs = 'ready';
        setNotice(state.installScopeMode === 'selected_employees'
          ? '安装成功：' + nextInstall.name + '。已按安装时选择的员工范围授权。'
          : '安装成功：' + nextInstall.name + '。默认已授权全员，可按需缩小员工范围。');
        render();
      });
    }

    function upgradeInstall(installId) {
      var install = findInstallById(installId);
      if (!install || !ns.api || !ns.api.patchSkillInstall || state.pendingInstallId) return Promise.resolve(null);
      state.pendingInstallId = installId;
      setNotice('正在升级技能：' + install.name);
      render();
      return ns.api.patchSkillInstall(installId, {
        version: install.latest_version || install.version,
        latest_version: install.latest_version || install.version,
      }).then(function (result) {
        state.pendingInstallId = '';
        if (!result.ok) {
          setNotice('技能升级失败：' + apiErrorMessage(result));
          render();
          return result;
        }
        upsertInstall(Object.assign({}, install, result.data || {}, {
          skill_id: install.skill_id,
          name: install.name,
          source: install.source,
          granted_employee_ids: (result.data && result.data.grants || []).map(function (grant) { return grant.employee_id; }),
          update_available: false,
        }));
        setNotice('技能已升级到最新版本：' + install.name);
        render();
        return result;
      });
    }

    function updateScope(installId, scopeMode, employeeIds) {
      var install = findInstallById(installId);
      if (!install || !ns.api || !ns.api.patchSkillInstall || state.pendingInstallId) return Promise.resolve(null);
      state.pendingInstallId = installId;
      setNotice(scopeMode === 'all_employees' ? '正在切换为全员授权：' + install.name : '正在更新授权员工：' + install.name);
      render();
      return ns.api.patchSkillInstall(installId, {
        scope_mode: scopeMode,
        employee_ids: scopeMode === 'all_employees' ? undefined : employeeIds,
      }).then(function (result) {
        state.pendingInstallId = '';
        if (!result.ok) {
          setNotice('技能授权范围更新失败：' + apiErrorMessage(result));
          render();
          return result;
        }
        upsertInstall(Object.assign({}, install, result.data || {}, {
          skill_id: install.skill_id,
          name: install.name,
          source: install.source,
          scope_mode: scopeMode,
          visibility: scopeMode,
          granted_employee_ids: (result.data && result.data.grants || []).map(function (grant) { return grant.employee_id; }),
          update_available: install.update_available,
        }));
        setNotice(scopeMode === 'all_employees' ? '技能已授权给全员：' + install.name : '技能授权员工已更新：' + install.name);
        render();
        return result;
      });
    }

    function uninstallInstall(installId) {
      var install = findInstallById(installId);
      if (!install || !ns.api || !ns.api.deleteSkillInstall || state.pendingInstallId) return Promise.resolve(null);
      state.pendingInstallId = installId;
      setNotice('正在卸载技能：' + install.name);
      render();
      return ns.api.deleteSkillInstall(installId).then(function (result) {
        state.pendingInstallId = '';
        if (!result.ok) {
          setNotice('技能卸载失败：' + apiErrorMessage(result));
          render();
          return result;
        }
        state.installs = state.installs.filter(function (item) { return item.install_id !== installId; });
        setNotice('技能已卸载：' + install.name);
        render();
        return result;
      });
    }

    function load() {
      container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载技能市场...</p></div>';
      ns.api.getSkillInstalls().then(function (installResult) {
        if (installResult.ok) {
          state.installs = normalizeItems(installResult.data).map(normalizeInstall);
          state.loadState.installs = 'ready';
        } else {
          state.installs = [];
          state.loadState.installs = installResult.status === 501 ? 'degraded' : 'error';
          if (installResult.status !== 501) {
            setNotice('企业技能库读取失败：' + apiErrorMessage(installResult));
          }
        }

        ns.api.getSkillCatalog().then(function (catalogResult) {
          if (catalogResult.ok) {
            state.catalog = normalizeItems(catalogResult.data).map(normalizeCatalogItem);
            state.loadState.catalog = 'ready';
          } else {
            state.catalog = [];
            state.loadState.catalog = catalogResult.status === 501 ? 'degraded' : 'error';
            if (catalogResult.status !== 501) {
              setNotice('技能市场读取失败：' + apiErrorMessage(catalogResult));
            }
          }
          render();
        });
      });
    }

    return {
      load: load,
      render: render,
      state: state,
      __test: {
        normalizeInstall: normalizeInstall,
        normalizeCatalogItem: normalizeCatalogItem,
        filterCatalog: filterCatalog,
        setInstallScope: setInstallScope,
        installSkill: installSkill,
        upgradeInstall: upgradeInstall,
        updateScope: updateScope,
        uninstallInstall: uninstallInstall,
        findInstallById: findInstallById,
      }
    };
  }

  ns.pages.adminSkills = {
    init: function (container) {
      if (!container) return;
      var role = ns.role ? ns.role.getActiveRole() : '';
      if (role && (!ns.role || !ns.role.hasPermission || !ns.role.hasPermission(role, 'manage_employees'))) {
        renderPermissionDenied(container);
        return;
      }
      var controller = createPageController(container);
      controller.load();
    },
    __test: {
      normalizeInstall: normalizeInstall,
      normalizeCatalogItem: normalizeCatalogItem,
      filterCatalog: filterCatalog,
      createController: createPageController,
    }
  };
}(window.aiteam));
