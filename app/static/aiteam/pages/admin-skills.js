// admin-skills.js — B02 skill market and install shell
window.aiteam = window.aiteam || {};

(function registerAdminSkillsPage(ns) {
  ns.pages = ns.pages || {};

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
    return {
      install_id: stringValue(item && item.install_id, ''),
      skill_id: stringValue(item && (item.skill_id || item.skill_code), ''),
      name: stringValue(item && item.name, item && (item.skill_id || item.skill_code) || '未命名技能'),
      version: stringValue(item && item.version, '—'),
      source: stringValue(item && item.source, 'custom'),
      visibility: stringValue(item && item.visibility, 'enterprise'),
      granted_employee_ids: Array.isArray(item && item.granted_employee_ids) ? item.granted_employee_ids.slice() : [],
      updated_at: stringValue(item && (item.updated_at || item.installed_at), ''),
      latest_version: stringValue(item && item.latest_version, ''),
      update_available: !!(item && item.update_available),
      audit_status: stringValue(item && item.audit_status, ''),
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
    if (result && result.status === 404) return '技能市场接口尚未开放';
    if (result && result.status === 501) return '技能市场接口尚未实现';
    if (result && result.error) return result.error;
    if (result && typeof result.status !== 'undefined') return '请求失败 (' + result.status + ')';
    return '网络请求失败';
  }

  function renderInstallCard(item) {
    var grants = Array.isArray(item.granted_employee_ids) ? item.granted_employee_ids.length : 0;
    var versionLine = item.update_available && item.latest_version
      ? '版本 ' + esc(item.version) + ' → ' + esc(item.latest_version) + '（待后端接入更新接口）'
      : '版本 ' + esc(item.version) + ' · 来源 ' + esc(item.source);
    var auditLine = item.audit_status
      ? '<div class="aiteam-skill-card__meta">审计状态：' + esc(item.audit_status) + '</div>'
      : '<div class="aiteam-skill-card__meta">审计追踪：当前后端未返回安装审计字段，前端保留可见降级提示。</div>';
    var updatedLine = item.updated_at
      ? '<div class="aiteam-skill-card__meta">最近安装时间：' + esc(item.updated_at) + '</div>'
      : '';
    return '<li class="aiteam-skill-card">' +
      '<div class="aiteam-skill-card__title">' + esc(item.name) + '</div>' +
      '<div class="aiteam-skill-card__meta">' + versionLine + '</div>' +
      '<div class="aiteam-skill-card__meta">可见性：' + esc(item.visibility) + ' · 已授权员工：' + esc(grants) + '</div>' +
      updatedLine +
      auditLine +
      '<div class="aiteam-skill-card__actions">' +
      '<button type="button" class="aiteam-btn aiteam-btn--secondary" disabled>卸载待后端接入</button>' +
      '<button type="button" class="aiteam-btn aiteam-btn--secondary" disabled>员工授权请前往员工详情</button>' +
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
      notices: [],
      loadState: {
        installs: 'loading',
        catalog: 'loading'
      }
    };

    function setNotice(message) {
      state.notices = message ? [message] : [];
    }

    function buildDegradationNotes() {
      var notices = state.notices.slice();
      if (state.loadState.installs !== 'ready') {
        notices.push('已安装技能接口未完全就绪：页面仍展示技能市场与授权入口说明。');
      }
      if (state.loadState.catalog !== 'ready') {
        notices.push('技能市场目录接口未完全就绪：页面保留搜索和降级占位，不伪造缺失数据。');
      }
      notices.push('员工授权闭环已接入员工详情抽屉；技能卸载/升级仍依赖后端补充接口。');
      return notices;
    }

    function filteredCatalog() {
      return filterCatalog(state.catalog, state.query);
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
      var buttons = container.querySelectorAll('[data-role="install-skill"]');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].addEventListener('click', function () {
          installSkill(this.getAttribute('data-skill-id'));
        });
      }
    }

    function render() {
      var installsById = installedLookup(state.installs);
      var visibleCatalog = filteredCatalog();
      var installedMarkup = state.installs.length
        ? state.installs.map(renderInstallCard).join('')
        : '<li class="aiteam-skill-card"><div class="aiteam-skill-card__meta">企业技能库暂无已安装技能</div></li>';
      var catalogMarkup = visibleCatalog.length
        ? visibleCatalog.map(function (item) { return renderCatalogCard(item, installsById, state); }).join('')
        : '<li class="aiteam-skill-card"><div class="aiteam-skill-card__meta">当前筛选条件下暂无可展示技能</div></li>';
      var notices = buildDegradationNotes();
      container.innerHTML =
        '<div class="aiteam-shell__panel">' +
        '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
        '<h2 class="aiteam-shell__panel-title">技能市场</h2>' +
        '<p class="aiteam-shell__panel-body">企业技能库与市场浏览共用 Team Panel 北向契约，读取 /api/team/skills/catalog 与 /api/team/skills/installs，安装写入 /api/team/skills/installs。安装后可在员工配置中通过 skills_add / skills_remove 完成授权。</p>' +
        '<div class="aiteam-skill-summary">' +
        '<span class="aiteam-skill-summary__item">已安装 ' + esc(state.installs.length) + ' 项</span>' +
        '<span class="aiteam-skill-summary__item">市场可见 ' + esc(visibleCatalog.length) + ' 项</span>' +
        '<span class="aiteam-skill-summary__item">员工授权入口：员工详情抽屉</span>' +
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
      state.pendingSkillId = skillId;
      setNotice('正在安装技能：' + skillId);
      render();
      ns.api.installSkill({ skill_id: skillId }).then(function (result) {
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
          visibility: 'enterprise',
          granted_employee_ids: []
        });
        state.installs = state.installs.filter(function (item) {
          return item.skill_id !== nextInstall.skill_id;
        });
        state.installs.push(nextInstall);
        state.loadState.installs = 'ready';
        setNotice('安装成功：' + nextInstall.name + '。员工授权请前往员工详情抽屉继续操作。');
        render();
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
      }
    };
  }

  ns.pages.adminSkills = {
    init: function (container) {
      if (!container) return;
      var controller = createPageController(container);
      controller.load();
    },
    __test: {
      normalizeInstall: normalizeInstall,
      normalizeCatalogItem: normalizeCatalogItem,
      filterCatalog: filterCatalog,
    }
  };
}(window.aiteam));
