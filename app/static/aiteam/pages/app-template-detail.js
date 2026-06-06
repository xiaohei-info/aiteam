window.aiteam = window.aiteam || {};

(function registerTemplateDetailPage(ns) {
  ns.pages = ns.pages || {};
  var escapeHtml = (ns.util && ns.util.escapeHtml) || function (value) { return String(value == null ? '' : value); };

  function getTemplateId(pathname) {
    var parts = String(pathname || window.location.pathname || '').split('/');
    return parts.length >= 4 ? decodeURIComponent(parts[3]) : '';
  }

  function section(title, bodyHtml) {
    return '<section class="aiteam-detail-section"><h3>' + escapeHtml(title) + '</h3>' + bodyHtml + '</section>';
  }

  function listOrEmpty(items, emptyText) {
    if (!items || !items.length) {
      return '<p class="aiteam-inline-empty">' + escapeHtml(emptyText) + '</p>';
    }
    return '<ul class="aiteam-detail-list">' + items.map(function (item) {
      return '<li>' + escapeHtml(item) + '</li>';
    }).join('') + '</ul>';
  }

  function recruitTemplate(templateId, feedback) {
    feedback.textContent = '正在创建招募订单...';
    ns.api.recruit({
      template_id: templateId,
      display_name: '新招募成员',
      idempotency_key: 'detail-recruit-' + templateId,
    }).then(function (result) {
      if (!result.ok) {
        feedback.textContent = result.status === 429 ? '招募过于频繁，请稍后再试。' : (result.error || '招募失败，请稍后重试。');
        return;
      }
      feedback.textContent = '招募成功，员工 ID：' + escapeHtml((result.data && result.data.employee_id) || '');
    });
  }

  function renderDetail(container, detail) {
    var skills = Array.isArray(detail.default_skills) ? detail.default_skills : [];
    var knowledge = Array.isArray(detail.knowledge_bindings) ? detail.knowledge_bindings : [];
    var connectors = Array.isArray(detail.connector_requirements) ? detail.connector_requirements : [];
    var memory = detail.default_memory_config || {};
    var memorySummary = [
      memory.type ? '类型：' + memory.type : '',
      memory.max_tokens ? '上限：' + memory.max_tokens + ' tokens' : '',
    ].filter(Boolean);

    container.innerHTML = '<section class="aiteam-page">' +
      '<div class="aiteam-page__hero">' +
      '<div><p class="aiteam-page__eyebrow">P04 · 专家详情</p><h2 class="aiteam-page__title">' + escapeHtml(detail.name || detail.template_id || '模板详情') + '</h2>' +
      '<p class="aiteam-page__desc">查看模板默认技能、知识与记忆绑定，再决定是否招募到企业工作台。</p></div>' +
      '<div class="aiteam-hero-actions"><a class="aiteam-button aiteam-button--ghost" href="/app/marketplace">返回人才市场</a><button class="aiteam-button" type="button" data-template-detail-recruit>立即招募</button></div>' +
      '</div>' +
      '<section class="aiteam-panel">' +
      '<div class="aiteam-tab-strip">' +
      '<span class="aiteam-tab is-active">档案</span>' +
      '<span class="aiteam-tab">技能</span>' +
      '<span class="aiteam-tab">知识</span>' +
      '<span class="aiteam-tab">记忆</span>' +
      '<span class="aiteam-tab">默认绑定</span>' +
      '</div>' +
      section('模板档案', '<p class="aiteam-card__body">' + escapeHtml(detail.description || '暂无模板描述。') + '</p><div class="aiteam-detail-kv"><span>分类</span><strong>' + escapeHtml(detail.category || '未分类') + '</strong></div><div class="aiteam-detail-kv"><span>价格档位</span><strong>' + escapeHtml(detail.price_tier || 'standard') + '</strong></div>') +
      section('默认技能', listOrEmpty(skills, '该模板暂未声明默认技能。')) +
      section('知识绑定', listOrEmpty(knowledge, '暂无预置知识库绑定。')) +
      section('记忆策略', listOrEmpty(memorySummary, '暂无默认记忆策略。')) +
      section('默认绑定 / 连接器需求', listOrEmpty(connectors, '暂无额外连接器要求。')) +
      '<p class="aiteam-inline-note" data-template-detail-feedback></p>' +
      '</section>' +
      '</section>';

    var button = container.querySelector('[data-template-detail-recruit]');
    var feedback = container.querySelector('[data-template-detail-feedback]');
    if (button && feedback) {
      button.addEventListener('click', function () {
        recruitTemplate(detail.template_id, feedback);
      });
    }
  }

  ns.pages.appTemplateDetail = {
    render: renderDetail,
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
        renderDetail(container, result.data || {});
      });
    },
  };
}(window.aiteam));
