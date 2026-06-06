window.aiteam = window.aiteam || {};

(function registerMarketplacePage(ns) {
  ns.pages = ns.pages || {};
  var escapeHtml = (ns.util && ns.util.escapeHtml) || function (value) { return String(value == null ? '' : value); };

  function getQuery() {
    try {
      return new URL(window.location.href).searchParams;
    } catch (_error) {
      return new URLSearchParams('');
    }
  }

  function normalizeItems(data) {
    return data && Array.isArray(data.items) ? data.items : [];
  }

  function matchesFilters(item, filters) {
    var keyword = filters.keyword;
    var category = filters.category;
    var tag = filters.tag;
    var haystack = [item.name, item.role, item.description].join(' ').toLowerCase();
    var tags = Array.isArray(item.tags) ? item.tags : [];
    if (keyword && haystack.indexOf(keyword) === -1 && !tags.join(' ').toLowerCase().includes(keyword)) {
      return false;
    }
    if (category && tags.indexOf(category) === -1) {
      return false;
    }
    if (tag && tags.indexOf(tag) === -1) {
      return false;
    }
    return true;
  }

  function uniqueTags(items) {
    var seen = {};
    var tags = [];
    items.forEach(function (item) {
      (Array.isArray(item.tags) ? item.tags : []).forEach(function (tag) {
        if (!tag || seen[tag]) return;
        seen[tag] = true;
        tags.push(tag);
      });
    });
    return tags;
  }

  function rateLimited(result) {
    var code = result && result.data && result.data.error && result.data.error.code;
    return result.status === 429 || code === 'RATE_LIMITED';
  }

  function recruitTemplate(templateId, card, feedback) {
    if (!templateId) return;
    feedback.textContent = '正在招募中...';
    card.classList.add('is-recruiting');
    ns.api.recruit({
      template_id: templateId,
      display_name: '新招募成员',
      idempotency_key: 'recruit-' + templateId,
    }).then(function (result) {
      card.classList.remove('is-recruiting');
      if (!result.ok) {
        feedback.textContent = rateLimited(result) ? '请求过快，请稍后重试。' : (result.error || '招募失败，请稍后再试。');
        return;
      }
      feedback.textContent = '招募成功，已创建员工 ' + escapeHtml((result.data && result.data.employee_id) || '');
    });
  }

  function renderCards(items, filters) {
    var visible = items.filter(function (item) { return matchesFilters(item, filters); });
    if (!visible.length) {
      return '<div class="aiteam-inline-empty">没有符合筛选条件的人才模板。</div>';
    }
    return visible.map(function (item) {
      var tags = (Array.isArray(item.tags) ? item.tags : []).map(function (tag) {
        return '<span class="aiteam-tag">' + escapeHtml(tag) + '</span>';
      }).join('');
      return '<article class="aiteam-card aiteam-template-card" data-template-id="' + escapeHtml(item.template_id || '') + '">' +
        '<div class="aiteam-card__row"><div><h3 class="aiteam-card__title">' + escapeHtml(item.name || item.template_id || '未命名模板') + '</h3>' +
        '<p class="aiteam-card__sub">' + escapeHtml(item.role || '未定义角色') + '</p></div><span class="aiteam-badge">招募 ' + escapeHtml(item.recruit_count || 0) + '</span></div>' +
        '<p class="aiteam-card__body">' + escapeHtml(item.description || '可用于快速招募数字员工。') + '</p>' +
        '<div class="aiteam-tag-row">' + tags + '</div>' +
        '<div class="aiteam-action-row">' +
        '<a class="aiteam-button aiteam-button--ghost" href="/app/marketplace/' + encodeURIComponent(item.template_id || '') + '">查看详情</a>' +
        '<button class="aiteam-button" type="button" data-recruit-template="' + escapeHtml(item.template_id || '') + '">立即招募</button>' +
        '</div>' +
        '<p class="aiteam-inline-note" data-recruit-feedback></p>' +
        '</article>';
    }).join('');
  }

  function bindInteractions(container) {
    Array.prototype.slice.call(container.querySelectorAll('[data-recruit-template]')).forEach(function (button) {
      button.addEventListener('click', function () {
        var card = button.closest('.aiteam-template-card');
        var feedback = card ? card.querySelector('[data-recruit-feedback]') : null;
        if (!feedback) return;
        recruitTemplate(button.getAttribute('data-recruit-template'), card, feedback);
      });
    });
  }

  function renderMarketplace(container, data) {
    var params = getQuery();
    var items = normalizeItems(data);
    var filters = {
      keyword: (params.get('q') || '').trim().toLowerCase(),
      category: (params.get('category') || '').trim(),
      tag: (params.get('tag') || '').trim(),
    };
    var tags = uniqueTags(items);
    var chipHtml = tags.map(function (tag) {
      var active = filters.category === tag || filters.tag === tag ? ' is-active' : '';
      return '<a class="aiteam-filter-chip' + active + '" href="/app/marketplace?tag=' + encodeURIComponent(tag) + '">' + escapeHtml(tag) + '</a>';
    }).join('');

    container.innerHTML = '<section class="aiteam-page">' +
      '<div class="aiteam-page__hero">' +
      '<div><p class="aiteam-page__eyebrow">P03 · 人才市场</p><h2 class="aiteam-page__title">招募你的数字员工</h2><p class="aiteam-page__desc">搜索、筛选并查看模板详情，所有列表数据来自 Team Panel 人才市场接口。</p></div>' +
      '<div class="aiteam-hero-actions"><a class="aiteam-button" href="/app/workbench">回到工作台</a></div>' +
      '</div>' +
      '<section class="aiteam-panel"><div class="aiteam-toolbar">' +
      '<form class="aiteam-search" action="/app/marketplace"><input name="q" value="' + escapeHtml(params.get('q') || '') + '" placeholder="搜索岗位 / 能力 / 标签" /><button class="aiteam-button" type="submit">搜索</button></form>' +
      '<div class="aiteam-tag-row">' + chipHtml + '</div>' +
      '</div>' +
      '<div class="aiteam-card-grid">' + renderCards(items, filters) + '</div>' +
      '</section>' +
      '</section>';
    bindInteractions(container);
  }

  ns.pages.appMarketplace = {
    render: renderMarketplace,
    init: function (container) {
      if (!container) return;
      ns.states.renderLoading(container, '加载人才市场...');
      ns.api.getTalentTemplates().then(function (result) {
        if (!result.ok) {
          if (rateLimited(result)) {
            ns.states.renderError(container, '人才市场请求过于频繁，请稍后刷新重试。');
            return;
          }
          ns.states.handleApiResult(result, container, function () {});
          return;
        }
        renderMarketplace(container, result.data || {});
      });
    },
  };
}(window.aiteam));
