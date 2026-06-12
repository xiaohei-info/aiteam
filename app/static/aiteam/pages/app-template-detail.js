window.aiteam = window.aiteam || {};

(function registerTemplateDetailPage(ns) {
  ns.pages = ns.pages || {};
  var escapeHtml = (ns.util && ns.util.escapeHtml) || function (value) { return String(value == null ? '' : value); };
  var CATEGORY_LABEL_MAP = {
    marketing: '市场营销',
    finance: '财务分析',
    engineering: '技术研发',
    tech: '技术研发',
    rd: '技术研发',
    support: '客户服务',
    customer_service: '客户服务',
    customer_success: '客户服务',
    service: '客户服务',
    hr: '人力资源',
    human_resources: '人力资源',
    people_ops: '人力资源',
    content: '内容创作',
    legal: '法务合规',
    operations: '运营增长',
  };
  var CATEGORY_ICON_MAP = {
    marketing: '🎯',
    finance: '📊',
    engineering: '💻',
    tech: '💻',
    rd: '💻',
    support: '🎧',
    customer_service: '🎧',
    customer_success: '🎧',
    service: '🎧',
    hr: '🧑‍💼',
    human_resources: '🧑‍💼',
    people_ops: '🧑‍💼',
    content: '✍️',
    legal: '⚖️',
    operations: '🚀',
  };
  var TAB_ITEMS = [
    { key: 'overview', label: '基本信息' },
    { key: 'skills', label: '技能列表' },
    { key: 'knowledge', label: '知识库' },
    { key: 'memory', label: '初始记忆' },
  ];

  function getTemplateId(pathname) {
    var parts = String(pathname || window.location.pathname || '').split('/');
    return parts.length >= 4 ? decodeURIComponent(parts[3]) : '';
  }

  function categoryLabel(value) {
    if (!value) return '未分类';
    return CATEGORY_LABEL_MAP[value] || value;
  }

  function categoryIcon(value) {
    if (!value) return '🤖';
    return CATEGORY_ICON_MAP[value] || '🤖';
  }

  function modelLabel(detail) {
    var ref = detail && detail.default_model_ref ? detail.default_model_ref : {};
    return ref.model || ref.model_name || ref.name || ref.provider || '标准模型';
  }

  function modelPickerHtml(state) {
    var models = (state && state.models) || [];
    if (!models.length) {
      return '<p class="aiteam-template-detail__model-hint">将使用模板默认模型（可在“企业后台 · 模型”中配置更多）。</p>';
    }
    var opts = ['<option value="">使用模板默认模型</option>'];
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      var label = (m.provider_name || m.provider_key) + ' · ' + (m.label || m.model_id);
      opts.push('<option value="' + escapeHtml(m.model_uid) + '"'
        + (state.selectedModelUid === m.model_uid ? ' selected' : '')
        + '>' + escapeHtml(label) + '</option>');
    }
    return '<label class="aiteam-template-detail__model"><span>选择模型</span>'
      + '<select data-template-detail-model>' + opts.join('') + '</select></label>';
  }

  function formatNumber(value) {
    var number = Number(value || 0);
    if (typeof number.toLocaleString === 'function') {
      return number.toLocaleString('zh-CN');
    }
    return String(number);
  }

  function defaultSkillList(detail) {
    return Array.isArray(detail && detail.default_skills) ? detail.default_skills : [];
  }

  function tagsList(detail) {
    return Array.isArray(detail && detail.tags) ? detail.tags : [];
  }

  function normalizeKnowledgeList(detail) {
    var items = Array.isArray(detail && detail.knowledge_bindings) ? detail.knowledge_bindings : [];
    return items.map(function (item) {
      if (item && typeof item === 'object') {
        var scope = item.scope ? ' · ' + item.scope : '';
        return {
          title: item.knowledge_id || item.name || '未命名知识库',
          body: scope ? ('范围' + scope) : '企业招募后可替换绑定范围',
        };
      }
      return {
        title: String(item),
        body: '企业招募后可替换绑定范围',
      };
    });
  }

  function normalizeConnectorList(detail) {
    var items = Array.isArray(detail && detail.connector_requirements) ? detail.connector_requirements : [];
    return items.map(function (item) {
      if (item && typeof item === 'object') {
        var required = item.required ? '必需' : '可选';
        return {
          title: item.connector_type || item.name || '未命名连接器',
          body: required + '连接能力',
        };
      }
      return {
        title: String(item),
        body: '连接器能力',
      };
    });
  }

  function memorySummary(detail) {
    var memory = detail && detail.default_memory_config ? detail.default_memory_config : {};
    var rows = [];
    if (memory.type) rows.push({ label: '记忆类型', value: memory.type });
    if (memory.max_tokens) rows.push({ label: '记忆上限', value: memory.max_tokens + ' tokens' });
    Object.keys(memory || {}).forEach(function (key) {
      if (key === 'type' || key === 'max_tokens') return;
      rows.push({ label: key, value: memory[key] });
    });
    return rows;
  }

  function overviewFacts(detail) {
    return [
      { label: '岗位类别', value: categoryLabel(detail.category) },
      { label: '底层大模型', value: modelLabel(detail) },
      { label: '价格档位', value: detail.price_tier || 'standard' },
    ];
  }

  function renderTagRow(tags) {
    if (!tags.length) {
      return '<p class="aiteam-inline-empty">暂无能力标签。</p>';
    }
    return '<div class="aiteam-tag-row aiteam-template-detail__tag-row">' + tags.map(function (tag) {
      return '<span class="aiteam-tag aiteam-template-detail__tag">' + escapeHtml(tag) + '</span>';
    }).join('') + '</div>';
  }

  function renderFactGrid(items) {
    return '<div class="aiteam-template-detail__fact-grid">' + items.map(function (item) {
      return '<div class="aiteam-template-detail__fact-card"><span class="aiteam-template-detail__fact-label">' + escapeHtml(item.label) + '</span><strong class="aiteam-template-detail__fact-value">' + escapeHtml(item.value) + '</strong></div>';
    }).join('') + '</div>';
  }

  function renderUsageStats(detail) {
    var usage = detail && detail.usage_stats ? detail.usage_stats : {};
    var skills = defaultSkillList(detail);
    return '<div class="aiteam-template-detail__stats">' +
      '<div class="aiteam-template-detail__stat-card"><strong>' + escapeHtml(formatNumber(usage.total_recruits || 0)) + '</strong><span>企业已招募</span></div>' +
      '<div class="aiteam-template-detail__stat-card"><strong>' + escapeHtml(formatNumber(usage.active_instances || 0)) + '</strong><span>活跃实例</span></div>' +
      '<div class="aiteam-template-detail__stat-card"><strong>' + escapeHtml(String(skills.length)) + '</strong><span>配置技能数</span></div>' +
      '</div>';
  }

  function renderDescription(detail) {
    return '<section class="aiteam-template-detail__section">' +
      '<span class="aiteam-template-detail__section-kicker">岗位描述</span>' +
      '<p class="aiteam-template-detail__description">' + escapeHtml(detail.description || '暂无岗位描述。') + '</p>' +
      '</section>';
  }

  function renderCapabilitySection(detail) {
    return '<section class="aiteam-template-detail__section">' +
      '<div class="aiteam-template-detail__section-head"><h3>能力标签</h3><span>该专家擅长的领域与技能</span></div>' +
      renderTagRow(tagsList(detail)) +
      '</section>';
  }

  function renderListCards(items, emptyText) {
    if (!items.length) {
      return '<p class="aiteam-inline-empty">' + escapeHtml(emptyText) + '</p>';
    }
    return '<div class="aiteam-template-detail__list">' + items.map(function (item) {
      return '<article class="aiteam-template-detail__list-card"><strong>' + escapeHtml(item.title) + '</strong><p>' + escapeHtml(item.body) + '</p></article>';
    }).join('') + '</div>';
  }

  function renderSkillsTab(detail) {
    var skills = defaultSkillList(detail).map(function (item) {
      return { title: item, body: '来自模板默认技能绑定，可在招募后按企业策略调整。' };
    });
    var connectors = normalizeConnectorList(detail);
    return '<div class="aiteam-template-detail__tab-panel">' +
      '<section class="aiteam-template-detail__section"><div class="aiteam-template-detail__section-head"><h3>技能列表</h3><span>展示模板预置 skill_name / 来源说明</span></div>' + renderListCards(skills, '该模板暂未声明默认技能。') + '</section>' +
      '<section class="aiteam-template-detail__section"><div class="aiteam-template-detail__section-head"><h3>配套连接能力</h3><span>连接器需求与招募后授权分离</span></div>' + renderListCards(connectors, '暂无额外连接器要求。') + '</section>' +
      '</div>';
  }

  function renderKnowledgeTab(detail) {
    return '<div class="aiteam-template-detail__tab-panel">' +
      '<section class="aiteam-template-detail__section"><div class="aiteam-template-detail__section-head"><h3>知识库</h3><span>展示模板关联的知识绑定列表</span></div>' + renderListCards(normalizeKnowledgeList(detail), '暂无预置知识库绑定。') + '</section>' +
      '</div>';
  }

  function renderMemoryTab(detail) {
    var rows = memorySummary(detail);
    if (!rows.length) {
      return '<div class="aiteam-template-detail__tab-panel"><p class="aiteam-inline-empty">暂无默认记忆策略。</p></div>';
    }
    return '<div class="aiteam-template-detail__tab-panel"><section class="aiteam-template-detail__section"><div class="aiteam-template-detail__section-head"><h3>初始记忆</h3><span>system prompt 预置记忆条目概览</span></div><div class="aiteam-template-detail__memory-list">' + rows.map(function (item) {
      return '<div class="aiteam-template-detail__memory-item"><span>' + escapeHtml(item.label) + '</span><strong>' + escapeHtml(item.value) + '</strong></div>';
    }).join('') + '</div></section></div>';
  }

  function renderOverviewTab(detail) {
    return '<div class="aiteam-template-detail__tab-panel">' +
      renderDescription(detail) +
      renderCapabilitySection(detail) +
      '<section class="aiteam-template-detail__section"><div class="aiteam-template-detail__section-head"><h3>能力说明</h3><span>岗位、模型与价格档位说明</span></div>' + renderFactGrid(overviewFacts(detail)) + '</section>' +
      '<section class="aiteam-template-detail__section"><div class="aiteam-template-detail__section-head"><h3>使用情况</h3><span>招募前查看模板活跃度与启用规模</span></div>' + renderUsageStats(detail) + '</section>' +
      '</div>';
  }

  function renderTabBody(detail, activeTab) {
    if (activeTab === 'skills') return renderSkillsTab(detail);
    if (activeTab === 'knowledge') return renderKnowledgeTab(detail);
    if (activeTab === 'memory') return renderMemoryTab(detail);
    return renderOverviewTab(detail);
  }

  function navigateBack() {
    if (window.location && typeof window.location.assign === 'function') {
      window.location.assign('/app/marketplace');
      return;
    }
    if (window.history && typeof window.history.back === 'function') {
      window.history.back();
    }
  }

  function rateLimited(result) {
    var code = result && result.data && result.data.error && result.data.error.code;
    return result && (result.status === 429 || code === 'RATE_LIMITED');
  }

  function confirmRecruit(name) {
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
    return !!window.confirm('确认招募「' + name + '」到企业工作台吗？');
  }

  function bindTabClicks(container, state) {
    var nodes = container.querySelectorAll('[data-template-detail-tab]');
    Array.prototype.forEach.call(nodes || [], function (node) {
      node.addEventListener('click', function () {
        state.activeTab = String(node.getAttribute('data-template-detail-tab') || 'overview');
        renderState(container, state);
      });
    });
  }

  function bindDismiss(container) {
    var overlay = container.querySelector('[data-template-detail-dismiss]');
    var close = container.querySelector('[data-template-detail-close]');
    if (overlay) overlay.addEventListener('click', navigateBack);
    if (close) close.addEventListener('click', navigateBack);
  }

  function recruitTemplate(container, state) {
    if (!state.detail || state.recruiting) return;
    if (!confirmRecruit(state.detail.name || '该专家')) return;
    state.recruiting = true;
    state.feedback = '正在创建招募订单...';
    state.successPayload = null;
    renderState(container, state);
    ns.api.recruit({
      template_id: state.detail.template_id,
      display_name: state.detail.name || '新招募成员',
      idempotency_key: 'recruit-' + state.detail.template_id,
      model_uid: state.selectedModelUid || '',
    }).then(function (result) {
      state.recruiting = false;
      if (!result.ok) {
        state.feedback = rateLimited(result) ? '请求过快，请稍后重试。' : (result.error || '招募失败，请稍后再试。');
        state.successPayload = null;
        renderState(container, state);
        return;
      }
      state.recruited = true;
      state.successPayload = result.data || {};
      state.feedback = '招募成功，已创建员工 ' + ((result.data && result.data.employee_id) || '') + '；已同步到工作台与员工管理。';
      if (state.detail && state.detail.usage_stats) {
        state.detail.usage_stats.total_recruits = Number(state.detail.usage_stats.total_recruits || 0) + 1;
        state.detail.usage_stats.active_instances = Number(state.detail.usage_stats.active_instances || 0) + 1;
      }
      renderState(container, state);
    });
  }

  function bindRecruit(container, state) {
    var button = container.querySelector('[data-template-detail-recruit]');
    var secondary = container.querySelector('[data-template-detail-dismiss-action]');
    if (button) {
      button.addEventListener('click', function () {
        recruitTemplate(container, state);
      });
    }
    if (secondary) {
      secondary.addEventListener('click', navigateBack);
    }
    var modelSelect = container.querySelector('[data-template-detail-model]');
    if (modelSelect) {
      modelSelect.addEventListener('change', function () {
        state.selectedModelUid = modelSelect.value || '';
      });
    }
  }

  function renderState(container, state) {
    var detail = state.detail || {};
    var skills = defaultSkillList(detail);
    var tabsHtml = TAB_ITEMS.map(function (tab) {
      var active = state.activeTab === tab.key ? ' is-active' : '';
      return '<button class="aiteam-template-detail__tab' + active + '" type="button" data-template-detail-tab="' + escapeHtml(tab.key) + '">' + escapeHtml(tab.label) + '</button>';
    }).join('');
    var buttonLabel = state.recruited ? '已招募' : (state.recruiting ? '招募中...' : '🚀 立即招募');
    var bodyHtml = renderTabBody(detail, state.activeTab);
    var statusText = categoryLabel(detail.category) + ' · ' + modelLabel(detail) + ' · ' + skills.length + ' Skills';
    var successPayload = state.successPayload || null;
    var avatar = detail.preview_avatar_url
      ? '<img class="aiteam-template-detail__avatar-image" src="' + escapeHtml(detail.preview_avatar_url) + '" alt="' + escapeHtml(detail.name || '模板头像') + '" />'
      : '<span>' + escapeHtml(categoryIcon(detail.category)) + '</span>';
    var recruitedActions = '';
    if (successPayload && successPayload.navigation) {
      var workbenchTarget = successPayload.navigation.workbench || '/app/workbench';
      var employeeAdminTarget = successPayload.navigation.employee_admin || '/admin/employees';
      var chatTarget = successPayload.navigation.chat || '';
      recruitedActions = '<div class="aiteam-action-row">' +
        '<a class="aiteam-button aiteam-button--ghost" href="' + escapeHtml(workbenchTarget) + '">去工作台查看</a>' +
        '<a class="aiteam-button aiteam-button--ghost" href="' + escapeHtml(employeeAdminTarget) + '">去配置员工</a>' +
        (chatTarget ? '<a class="aiteam-button" href="' + escapeHtml(chatTarget) + '">开始私聊</a>' : '') +
        '</div>';
    }

    container.innerHTML = '<section class="aiteam-page aiteam-template-detail">' +
      '<div class="aiteam-template-detail__overlay" data-template-detail-dismiss></div>' +
      '<div class="aiteam-template-detail__drawer">' +
      '<header class="aiteam-template-detail__header">' +
      '<div class="aiteam-template-detail__header-main">' +
      '<div class="aiteam-template-detail__avatar">' + avatar + '</div>' +
      '<div class="aiteam-template-detail__identity"><p class="aiteam-page__eyebrow">专家详情</p><h2>' + escapeHtml(detail.name || detail.template_id || '模板详情') + '</h2><p>' + escapeHtml(statusText) + '</p></div>' +
      '</div>' +
      '<button class="aiteam-template-detail__close" type="button" aria-label="关闭" data-template-detail-close>✕</button>' +
      '</header>' +
      '<div class="aiteam-template-detail__tabs">' + tabsHtml + '</div>' +
      '<div class="aiteam-template-detail__body">' + bodyHtml + '</div>' +
      '<footer class="aiteam-template-detail__footer">' +
      '<div class="aiteam-template-detail__footer-copy"><strong>招募前确认</strong><p>招募后可在企业后台继续调整该员工的技能、知识和记忆策略。</p>' +
      modelPickerHtml(state) +
      '</div>' +
      '<div class="aiteam-template-detail__footer-actions"><button class="aiteam-button" type="button" data-template-detail-recruit' + ((state.recruited || state.recruiting) ? ' disabled' : '') + '>' + escapeHtml(buttonLabel) + '</button><button class="aiteam-button aiteam-button--ghost" type="button" data-template-detail-dismiss-action>稍后再说</button></div>' +
      '<div class="aiteam-inline-note" data-template-detail-feedback>' + escapeHtml(state.feedback || '') + '</div>' +
      recruitedActions +
      '</footer>' +
      '</div>' +
      '</section>';

    bindTabClicks(container, state);
    bindDismiss(container);
    bindRecruit(container, state);
  }

  ns.pages.appTemplateDetail = {
    render: function (container, detail) {
      renderState(container, {
        detail: detail || {},
        activeTab: 'overview',
        feedback: '',
        recruiting: false,
        recruited: false,
        successPayload: null,
      });
    },
    init: function (container, options) {
      if (!container) return;
      var templateId = getTemplateId(options && options.pathname);
      if (!templateId) {
        ns.states.renderError(container, '缺少模板 ID，无法加载详情页。');
        return;
      }
      ns.states.renderLoading(container, '加载模板详情...');
      ns.api.getTemplate(templateId).then(function (result) {
        if (!result.ok) {
          ns.states.handleApiResult(result, container, function () {});
          return;
        }
        var baseState = {
          detail: result.data || {},
          activeTab: 'overview',
          feedback: '',
          recruiting: false,
          recruited: false,
          models: [],
          selectedModelUid: '',
        };
        var modelsP = (ns.api && ns.api.getLlmModels)
          ? ns.api.getLlmModels().then(function (r) { return (r && r.data && r.data.models) || []; }, function () { return []; })
          : Promise.resolve([]);
        modelsP.then(function (models) {
          baseState.models = models || [];
          renderState(container, baseState);
        });
      });
    },
  };
}(window.aiteam));
