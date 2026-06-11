window.aiteam = window.aiteam || {};

(function registerMarketplacePage(ns) {
  ns.pages = ns.pages || {};
  var escapeHtml = (ns.util && ns.util.escapeHtml) || function (value) { return String(value == null ? '' : value); };
  var DEFAULT_PAGE_SIZE = 20;
  var DEFAULT_SORT_BY = 'popularity';
  var DEFAULT_SORT_ORDER = 'desc';
  var SEARCH_DEBOUNCE_MS = 300;
  var CATEGORY_PRESETS = [
    { value: '', label: '全部', icon: '✨' },
    { value: 'marketing', label: '市场营销', icon: '🎯' },
    { value: 'finance', label: '财务分析', icon: '📊' },
    { value: 'engineering', label: '技术研发', icon: '💻' },
    { value: 'support', label: '客户服务', icon: '🎧' },
    { value: 'hr', label: '人力资源', icon: '🧑‍💼' },
  ];
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

  function getQuery() {
    try {
      return new URL(window.location.href).searchParams;
    } catch (_error) {
      return new URLSearchParams('');
    }
  }

  function parsePositiveInt(value, fallback) {
    var parsed = parseInt(value, 10);
    return parsed > 0 ? parsed : fallback;
  }

  function normalizeItems(data) {
    return data && Array.isArray(data.items) ? data.items : [];
  }

  function categoryLabel(value) {
    if (!value) return '全部';
    return CATEGORY_LABEL_MAP[value] || value;
  }

  function categoryIcon(value) {
    if (!value) return '✨';
    return CATEGORY_ICON_MAP[value] || '🤖';
  }

  function formatNumber(value) {
    var number = Number(value || 0);
    if (typeof number.toLocaleString === 'function') {
      return number.toLocaleString('zh-CN');
    }
    return String(number);
  }

  function modelLabel(item) {
    var ref = item && item.default_model_ref ? item.default_model_ref : {};
    return ref.model || ref.model_name || ref.name || ref.provider || '标准模型';
  }

  function skillsCount(item) {
    return Array.isArray(item && item.skills) ? item.skills.length : 0;
  }

  function collectCategories(items) {
    var tabs = CATEGORY_PRESETS.slice();
    var seen = {};
    tabs.forEach(function (item) { seen[item.value] = true; });
    normalizeItems({ items: items }).forEach(function (item) {
      var key = item && item.category ? String(item.category) : '';
      if (!key || seen[key]) return;
      seen[key] = true;
      tabs.push({ value: key, label: categoryLabel(key), icon: categoryIcon(key) });
    });
    return tabs;
  }

  function getFeedback(state, templateId) {
    return state.feedbackById[templateId] || '';
  }

  function getSuccessPayload(state, templateId) {
    return state.successById[templateId] || null;
  }

  function isRecruiting(state, templateId) {
    return !!state.recruitingById[templateId];
  }

  function rateLimited(result) {
    var code = result && result.data && result.data.error && result.data.error.code;
    return result && (result.status === 429 || code === 'RATE_LIMITED');
  }

  function readInitialState() {
    var params = getQuery();
    return {
      keyword: (params.get('q') || '').trim(),
      category: (params.get('category') || '').trim(),
      sortBy: (params.get('sort_by') || DEFAULT_SORT_BY).trim() || DEFAULT_SORT_BY,
      page: parsePositiveInt(params.get('page'), 1),
    };
  }

  function createState() {
    var initial = readInitialState();
    return {
      keyword: initial.keyword,
      category: initial.category,
      sortBy: initial.sortBy === 'created_at' ? 'created_at' : DEFAULT_SORT_BY,
      page: initial.page,
      pageSize: DEFAULT_PAGE_SIZE,
      items: [],
      total: 0,
      hasMore: false,
      loading: false,
      loadingMore: false,
      lastRequestId: 0,
      feedbackById: {},
      successById: {},
      recruitingById: {},
      searchTimer: 0,
    };
  }

  function buildQuery(state) {
    return {
      q: state.keyword || undefined,
      category: state.category || undefined,
      sort_by: state.sortBy || DEFAULT_SORT_BY,
      sort_order: DEFAULT_SORT_ORDER,
      page: state.page,
      page_size: state.pageSize,
    };
  }

  function syncUrl(state) {
    if (!window.history || typeof window.history.replaceState !== 'function') return;
    var params = new URLSearchParams('');
    if (state.keyword) params.set('q', state.keyword);
    if (state.category) params.set('category', state.category);
    if (state.sortBy && state.sortBy !== DEFAULT_SORT_BY) params.set('sort_by', state.sortBy);
    if (state.page > 1) params.set('page', String(state.page));
    var suffix = params.toString();
    window.history.replaceState(null, '', '/app/marketplace' + (suffix ? ('?' + suffix) : ''));
  }

  function requestTemplates(state) {
    syncUrl(state);
    return ns.api.getTalentTemplates({ query: buildQuery(state) });
  }

  function renderTags(tags) {
    return (Array.isArray(tags) ? tags : []).slice(0, 3).map(function (tag) {
      return '<span class="aiteam-tag">' + escapeHtml(tag) + '</span>';
    }).join('');
  }

  function renderCards(state) {
    if (!state.items.length) {
      return '<div class="aiteam-inline-empty aiteam-marketplace-empty">没有符合当前条件的人才模板。</div>';
    }
    return state.items.map(function (item) {
      var templateId = item.template_id || '';
      var recruited = !!item.is_recruited;
      var recruiting = isRecruiting(state, templateId);
      var successPayload = getSuccessPayload(state, templateId);
      var buttonLabel = recruited ? '已招募' : (recruiting ? '招募中...' : '立即招募');
      var noteText = getFeedback(state, templateId);
      var statusHtml = recruited
        ? '<span class="aiteam-marketplace-card__check">✓ 已招募</span>'
        : '<span class="aiteam-marketplace-card__pill">热度 ' + escapeHtml(formatNumber(item.recruit_count || 0)) + '</span>';
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
      return '<article class="aiteam-card aiteam-marketplace-card' + (recruited ? ' is-recruited' : '') + (recruiting ? ' is-recruiting' : '') + '" data-template-card="' + escapeHtml(templateId) + '">' +
        '<div class="aiteam-marketplace-card__status">' + statusHtml + '</div>' +
        '<a class="aiteam-marketplace-card__body" href="/app/marketplace/' + encodeURIComponent(templateId) + '">' +
        '<div class="aiteam-marketplace-card__hero">' +
        '<div class="aiteam-marketplace-card__avatar">' + escapeHtml(categoryIcon(item.category)) + '</div>' +
        '<div class="aiteam-marketplace-card__heading">' +
        '<h3 class="aiteam-card__title">' + escapeHtml(item.name || templateId || '未命名专家') + '</h3>' +
        '<p class="aiteam-card__sub">' + escapeHtml(item.role || categoryLabel(item.category || '')) + '</p>' +
        '</div>' +
        '</div>' +
        '<div class="aiteam-marketplace-card__meta">' +
        '<span>' + escapeHtml(modelLabel(item)) + '</span>' +
        '<span>' + escapeHtml(String(skillsCount(item))) + ' Skills</span>' +
        '</div>' +
        '<p class="aiteam-card__body">' + escapeHtml(item.description || '可用于快速招募数字员工。') + '</p>' +
        '<div class="aiteam-tag-row">' + renderTags(item.tags) + '</div>' +
        '<p class="aiteam-marketplace-card__recruiters">已有 ' + escapeHtml(formatNumber(item.recruit_count || 0)) + ' 家企业招募</p>' +
        '</a>' +
        '<div class="aiteam-marketplace-card__rating">⭐ ' +
        escapeHtml(String((item.rating != null ? item.rating : '4.8'))) +
        ' · 热度 ' + escapeHtml(formatNumber(item.recruit_count || 0)) + '</div>' +
        '<div class="aiteam-marketplace-card__footer">' +
        '<a class="aiteam-button aiteam-button--ghost" href="/app/marketplace/' + encodeURIComponent(templateId) + '">查看详情</a>' +
        '<button class="aiteam-button" type="button" data-recruit-template="' + escapeHtml(templateId) + '" data-recruit-name="' + escapeHtml(item.name || '新招募成员') + '"' + (recruited ? ' disabled' : '') + '>' + buttonLabel + '</button>' +
        '</div>' +
        '<p class="aiteam-inline-note" data-recruit-feedback="' + escapeHtml(templateId) + '">' + escapeHtml(noteText) + '</p>' +
        recruitedActions +
        '</article>';
    }).join('');
  }

  function renderFooter(state) {
    var pageCount = Math.max(1, Math.ceil((state.total || 0) / (state.pageSize || DEFAULT_PAGE_SIZE)));
    var summary = '第 ' + escapeHtml(String(state.page)) + ' / ' + escapeHtml(String(pageCount)) + ' 页 · 共 ' + escapeHtml(String(state.total || state.items.length || 0)) + ' 位专家';
    var actionHtml = '';
    if (state.hasMore) {
      actionHtml = '<button class="aiteam-button aiteam-marketplace-loadmore" type="button" data-marketplace-load-more>' + (state.loadingMore ? '加载中...' : '加载更多') + '</button>';
    }
    return '<div class="aiteam-marketplace-footer"><p class="aiteam-inline-note">' + summary + '</p>' + actionHtml + '</div>';
  }

  function renderMarketplace(container, state) {
    var categories = collectCategories(state.items);
    var categoryHtml = categories.map(function (item) {
      var active = state.category === item.value ? ' is-active' : '';
      return '<button class="aiteam-filter-chip' + active + '" type="button" data-marketplace-category="' + escapeHtml(item.value) + '">' + escapeHtml(item.icon) + ' ' + escapeHtml(item.label) + '</button>';
    }).join('');
    var loadingHint = state.loading && state.items.length ? '<span class="aiteam-inline-note">正在更新列表...</span>' : '';

    container.innerHTML = '<section class="aiteam-page">' +
      '<div class="aiteam-page__hero">' +
      '<div><h2 class="aiteam-page__title">🤝 人才市场</h2><p class="aiteam-page__desc">发现并雇用专业 AI 智能体，扩充你的数字员工团队。</p></div>' +
      '<div class="aiteam-hero-actions"><a class="aiteam-button aiteam-button--ghost" href="/app/chat">返回消息中心</a></div>' +
      '</div>' +
      '<section class="aiteam-panel">' +
      '<div class="aiteam-marketplace-toolbar">' +
      '<form class="aiteam-search aiteam-marketplace-search" action="/app/marketplace" data-marketplace-search-form>' +
      '<input name="q" value="' + escapeHtml(state.keyword) + '" placeholder="🔍 搜索专家名称、技能..." data-marketplace-search-input />' +
      '<button class="aiteam-button" type="submit">搜索</button>' +
      '</form>' +
      '<div class="aiteam-marketplace-toolbar__row">' +
      '<div class="aiteam-chip-row">' + categoryHtml + '</div>' +
      '<label class="aiteam-marketplace-sort">排序：<select class="aiteam-select" data-marketplace-sort><option value="popularity"' + (state.sortBy === 'popularity' ? ' selected' : '') + '>热度优先</option><option value="created_at"' + (state.sortBy === 'created_at' ? ' selected' : '') + '>最新上架</option></select></label>' +
      '</div>' +
      loadingHint +
      '</div>' +
      '<div class="aiteam-card-grid aiteam-marketplace-grid">' + renderCards(state) + '</div>' +
      renderFooter(state) +
      '</section>' +
      '</section>';

    bindInteractions(container, state);
  }

  function confirmRecruit(name) {
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
    return !!window.confirm('确认招募「' + name + '」到企业工作台吗？');
  }

  function updateRecruitedState(state, templateId) {
    state.items = state.items.map(function (item) {
      if (item.template_id !== templateId) return item;
      var successPayload = getSuccessPayload(state, templateId);
      return Object.assign({}, item, {
        is_recruited: true,
        recruit_count: Number(item.recruit_count || 0) + 1,
        employee_id: successPayload && successPayload.employee_id,
        conversation_id: successPayload && successPayload.conversation_id,
      });
    });
  }

  function recruitTemplate(container, state, templateId, templateName) {
    if (!templateId || isRecruiting(state, templateId)) return;
    if (!confirmRecruit(templateName || '该专家')) return;
    state.recruitingById[templateId] = true;
    state.feedbackById[templateId] = '正在创建招募订单...';
    renderMarketplace(container, state);
    ns.api.recruit({
      template_id: templateId,
      display_name: templateName || '新招募成员',
      idempotency_key: 'recruit-' + templateId,
    }).then(function (result) {
      delete state.recruitingById[templateId];
      if (!result.ok) {
        state.feedbackById[templateId] = rateLimited(result) ? '请求过快，请稍后重试。' : (result.error || '招募失败，请稍后再试。');
        delete state.successById[templateId];
        renderMarketplace(container, state);
        return;
      }
      state.successById[templateId] = result.data || {};
      updateRecruitedState(state, templateId);
      state.feedbackById[templateId] = '招募成功，已创建员工 ' + escapeHtml((result.data && result.data.employee_id) || '') + '；已同步到工作台与员工管理。';
      renderMarketplace(container, state);
    });
  }

  function bindInteractions(container, state) {
    var form = container.querySelector('[data-marketplace-search-form]');
    var input = container.querySelector('[data-marketplace-search-input]');
    var sortSelect = container.querySelector('[data-marketplace-sort]');
    var loadMoreButton = container.querySelector('[data-marketplace-load-more]');

    if (form && input) {
      form.addEventListener('submit', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (state.searchTimer) window.clearTimeout(state.searchTimer);
        state.keyword = String(input.value || '').trim();
        state.page = 1;
        loadTemplates(container, state, { append: false });
      });
      input.addEventListener('input', function () {
        if (state.searchTimer) window.clearTimeout(state.searchTimer);
        state.searchTimer = window.setTimeout(function () {
          state.keyword = String(input.value || '').trim();
          state.page = 1;
          loadTemplates(container, state, { append: false });
        }, SEARCH_DEBOUNCE_MS);
      });
    }

    if (sortSelect) {
      sortSelect.addEventListener('change', function () {
        state.sortBy = sortSelect.value === 'created_at' ? 'created_at' : DEFAULT_SORT_BY;
        state.page = 1;
        loadTemplates(container, state, { append: false });
      });
    }

    Array.prototype.slice.call(container.querySelectorAll('[data-marketplace-category]')).forEach(function (button) {
      button.addEventListener('click', function () {
        var category = button.getAttribute('data-marketplace-category') || '';
        if (state.category === category) return;
        state.category = category;
        state.page = 1;
        loadTemplates(container, state, { append: false });
      });
    });

    Array.prototype.slice.call(container.querySelectorAll('[data-recruit-template]')).forEach(function (button) {
      button.addEventListener('click', function () {
        recruitTemplate(
          container,
          state,
          button.getAttribute('data-recruit-template'),
          button.getAttribute('data-recruit-name') || '新招募成员'
        );
      });
    });

    if (loadMoreButton) {
      loadMoreButton.addEventListener('click', function () {
        if (state.loadingMore || !state.hasMore) return;
        state.page += 1;
        loadTemplates(container, state, { append: true });
      });
    }
  }

  function loadTemplates(container, state, options) {
    var append = !!(options && options.append);
    var requestId = state.lastRequestId + 1;
    state.lastRequestId = requestId;
    state.loading = !append;
    state.loadingMore = append;

    if (!append && (!state.items.length || !container.innerHTML)) {
      ns.states.renderLoading(container, '加载人才市场...');
    } else {
      renderMarketplace(container, state);
    }

    requestTemplates(state).then(function (result) {
      if (requestId !== state.lastRequestId) return;
      state.loading = false;
      state.loadingMore = false;
      if (!result.ok) {
        if (rateLimited(result)) {
          ns.states.renderError(container, '人才市场请求过于频繁，请稍后刷新重试。');
          return;
        }
        if (!append && ns.states && ns.states.handleApiResult) {
          ns.states.handleApiResult(result, container, function () {});
          return;
        }
        state.feedbackById.__page__ = result.error || '人才市场加载失败';
        renderMarketplace(container, state);
        return;
      }
      var payload = result.data || {};
      var items = normalizeItems(payload);
      state.items = append ? state.items.concat(items) : items;
      state.page = payload.page || state.page;
      state.pageSize = payload.page_size || state.pageSize;
      state.total = typeof payload.total === 'number' ? payload.total : state.items.length;
      state.hasMore = !!payload.has_more;
      renderMarketplace(container, state);
    });
  }

  ns.pages.appMarketplace = {
    render: function renderMarketplacePage(container, data) {
      if (!container) return;
      var state = createState();
      state.items = normalizeItems(data);
      state.page = data && data.page ? data.page : 1;
      state.pageSize = data && data.page_size ? data.page_size : DEFAULT_PAGE_SIZE;
      state.total = data && typeof data.total === 'number' ? data.total : state.items.length;
      state.hasMore = !!(data && data.has_more);
      renderMarketplace(container, state);
    },
    init: function initMarketplace(container) {
      if (!container) return;
      loadTemplates(container, createState(), { append: false });
    },
  };
}(window.aiteam));
