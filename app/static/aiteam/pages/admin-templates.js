window.aiteam = window.aiteam || {};

(function registerAdminTemplatesPage(ns) {
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

  function normalizeItems(payload) {
    if (!payload) return [];
    if (Array.isArray(payload.items)) return payload.items.slice();
    if (Array.isArray(payload.templates)) return payload.templates.slice();
    if (Array.isArray(payload)) return payload.slice();
    return [];
  }

  function normalizeTemplate(item) {
    return {
      template_id: stringValue(item && item.template_id, ''),
      name: stringValue(item && item.name, '未命名专家'),
      role: stringValue(item && item.role, '未配置角色'),
      category: stringValue(item && item.category, 'general'),
      description: stringValue(item && item.description, '暂无模板说明'),
      recruit_count: Number(item && item.recruit_count) || 0,
      is_recruited: !!(item && item.is_recruited),
      tags: Array.isArray(item && item.tags) ? item.tags.slice() : [],
    };
  }

  function apiErrorMessage(result) {
    if (result && result.status === 403) return '您没有权限查看企业后台人才市场';
    if (result && result.status === 404) return '人才市场暂时不可用';
    if (result && result.status === 501) return '人才市场暂时不可用';
    if (result && result.error) return result.error;
    if (result && typeof result.status !== 'undefined') return '请求失败 (' + result.status + ')';
    return '网络请求失败';
  }

  function createController(container) {
    var state = {
      items: [],
      notice: '',
      pendingTemplateId: '',
    };

    function setNotice(message) {
      state.notice = message || '';
    }

    function renderCard(item) {
      var tags = item.tags.length ? item.tags.join(' / ') : item.category;
      var recruitHint = item.is_recruited
        ? '企业内已有该模板员工，可继续招募新实例'
        : '当前企业尚未招募该模板';
      var pending = state.pendingTemplateId === item.template_id;
      return '<li class="aiteam-skill-card">' +
        '<div class="aiteam-skill-card__title">' + esc(item.name) + '</div>' +
        '<div class="aiteam-skill-card__meta">角色：' + esc(item.role) + ' · 分类：' + esc(item.category) + '</div>' +
        '<div class="aiteam-skill-card__meta">标签：' + esc(tags) + '</div>' +
        '<div class="aiteam-skill-card__meta">' + esc(item.description) + '</div>' +
        '<div class="aiteam-shell__meta">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">累计招募</span><span class="aiteam-shell__meta-value">' + esc(item.recruit_count) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">当前状态</span><span class="aiteam-shell__meta-value">' + esc(recruitHint) + '</span></div>' +
        '</div>' +
        '<div class="aiteam-skill-card__actions">' +
        '<a class="aiteam-btn aiteam-btn--secondary" href="/app/marketplace/' + esc(item.template_id) + '">查看专家详情</a>' +
        '<button type="button" class="aiteam-btn" data-role="template-recruit" data-template-id="' + esc(item.template_id) + '"' + (pending ? ' disabled' : '') + '>立即招募</button>' +
        '</div>' +
        '</li>';
    }

    function bindEvents() {
      if (!container || !container.querySelectorAll) return;
      var buttons = container.querySelectorAll('[data-role="template-recruit"]');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].addEventListener('click', function () {
          var templateId = this.getAttribute('data-template-id');
          recruitTemplate(templateId);
        });
      }
    }

    function render() {
      var cards = state.items.length
        ? state.items.map(renderCard).join('')
        : '<li class="aiteam-skill-card"><div class="aiteam-skill-card__meta">当前暂无可招募模板</div></li>';
      container.innerHTML =
        '<div class="aiteam-shell__panel">' +
        '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
        '<h2 class="aiteam-shell__panel-title">人才市场</h2>' +
        '<p class="aiteam-shell__panel-body">浏览数字员工模板，查看专家详情，并一键招募到企业团队。</p>' +
        (state.notice ? '<div class="aiteam-state aiteam-state-empty"><p>' + esc(state.notice) + '</p></div>' : '') +
        '<ul class="aiteam-skills-list">' + cards + '</ul>' +
        '</div>';
      bindEvents();
    }

    function load() {
      if (ns.states && ns.states.renderLoading) ns.states.renderLoading(container);
      else container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载后台人才市场...</p></div>';
      return ns.api.getAdminTemplates().then(function (result) {
        if (!result.ok) {
          setNotice(apiErrorMessage(result));
          state.items = [];
          render();
          return result;
        }
        state.items = normalizeItems(result.data).map(normalizeTemplate);
        setNotice('');
        render();
        return result;
      });
    }

    function recruitTemplate(templateId) {
      if (!templateId || !ns.api || !ns.api.recruit || state.pendingTemplateId) return Promise.resolve(null);
      state.pendingTemplateId = templateId;
      setNotice('');
      render();
      return ns.api.recruit({
        template_id: templateId,
        display_name: '新招募员工',
        idempotency_key: 'admin-template-recruit-' + templateId,
      }).then(function (result) {
        state.pendingTemplateId = '';
        if (!result.ok) {
          setNotice('招募失败：' + apiErrorMessage(result));
          render();
          return result;
        }
        var navigation = result.data && result.data.navigation || {};
        var target = navigation.workbench || '/app/workbench';
        setNotice('招募成功，已创建员工。可前往工作台继续使用：' + target);
        return load().then(function () {
          setNotice('招募成功，已创建员工。可前往工作台继续使用：' + target);
          render();
          return result;
        });
      });
    }

    return {
      load: load,
      __test: {
        recruitTemplate: recruitTemplate,
      },
    };
  }

  ns.pages.adminTemplates = {
    init: function (container) {
      if (!container) return;
      var role = ns.role ? ns.role.getActiveRole() : '';
      if (role && (!ns.role || !ns.role.hasPermission || !ns.role.hasPermission(role, 'manage_employees'))) {
        renderPermissionDenied(container);
        return;
      }
      if (!ns.api || !ns.api.getAdminTemplates || !ns.api.recruit) {
        container.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>后台人才市场 API client 未加载</p></div>';
        return;
      }
      createController(container).load();
    },
    __test: {
      createController: createController,
      normalizeItems: normalizeItems,
      normalizeTemplate: normalizeTemplate,
    },
  };
}(window.aiteam));
