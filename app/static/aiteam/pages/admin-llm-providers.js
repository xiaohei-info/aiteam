// admin-llm-providers.js — enterprise LLM provider/model configuration
window.aiteam = window.aiteam || {};

(function registerAdminLlmProvidersPage(ns) {
  ns.pages = ns.pages || {};

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderPermissionDenied(container) {
    if (!container) return;
    if (ns.states && ns.states.renderPermissionDenied) {
      ns.states.renderPermissionDenied(container);
      return;
    }
    container.innerHTML = '<div class="aiteam-state aiteam-state-denied"><p>您没有权限访问此内容</p></div>';
  }

  function renderProviderCard(p) {
    var models = (p.models || []).map(function (m) {
      var def = m.is_default ? ' <span class="aiteam-tag">默认</span>' : '';
      return '<li class="aiteam-llm-model-row">'
        + '<span class="aiteam-llm-model-id">' + esc(m.model_id) + '</span>'
        + '<span class="aiteam-llm-model-label">' + esc(m.label || '') + '</span>'
        + '<span class="aiteam-llm-model-ctx">' + (m.context_length ? esc(m.context_length) + ' ctx' : '') + '</span>'
        + def
        + '<button class="aiteam-btn aiteam-btn-text" data-role="llm-del-model" data-model="' + esc(m.model_uid) + '">删除</button>'
        + '</li>';
    }).join('');
    if (!models) {
      models = '<li class="aiteam-llm-model-empty">尚未配置模型</li>';
    }
    return '<div class="aiteam-llm-provider" data-provider="' + esc(p.provider_id) + '">'
      + '<div class="aiteam-llm-provider-head">'
      + '<div><strong>' + esc(p.display_name || p.provider_key) + '</strong>'
      + ' <code>' + esc(p.provider_key) + '</code></div>'
      + '<div class="aiteam-llm-provider-meta">'
      + '<span class="aiteam-tag ' + (p.enabled ? 'aiteam-tag-ok' : 'aiteam-tag-off') + '">'
      + (p.enabled ? '启用' : '停用') + '</span>'
      + '<span class="aiteam-llm-key">' + esc(p.api_key_mask || '') + '</span>'
      + '<button class="aiteam-btn aiteam-btn-text" data-role="llm-del-provider" data-provider="' + esc(p.provider_id) + '">删除</button>'
      + '</div></div>'
      + '<div class="aiteam-llm-provider-body">'
      + '<div class="aiteam-llm-baseurl">' + esc(p.base_url || '') + ' · ' + esc(p.transport || '') + '</div>'
      + '<ul class="aiteam-llm-models">' + models + '</ul>'
      + '<form class="aiteam-llm-model-form" data-role="llm-add-model-form" data-provider="' + esc(p.provider_id) + '">'
      + '<input type="text" name="model_id" placeholder="模型ID 如 gpt-5.4" required />'
      + '<input type="text" name="label" placeholder="显示名(可选)" />'
      + '<input type="number" name="context_length" placeholder="上下文长度" />'
      + '<label class="aiteam-llm-default"><input type="checkbox" name="is_default" /> 默认</label>'
      + '<button class="aiteam-btn aiteam-btn-sm" type="submit">添加模型</button>'
      + '</form>'
      + '</div></div>';
  }

  function renderPage(state) {
    var list = (state.providers || []).map(renderProviderCard).join('');
    if (!list) {
      list = '<div class="aiteam-state aiteam-state-empty"><p>尚未配置任何 LLM Provider</p></div>';
    }
    return '<div class="aiteam-page aiteam-llm-page">'
      + '<header class="aiteam-page-head"><h2>模型配置</h2>'
      + '<p class="aiteam-page-sub">配置企业可用的 LLM Provider 与模型；创建员工时从中选择模型。</p></header>'
      + (state.notice ? '<div class="aiteam-notice">' + esc(state.notice) + '</div>' : '')
      + '<section class="aiteam-card aiteam-llm-create">'
      + '<h3>新增 Provider</h3>'
      + '<form data-role="llm-create-provider-form" class="aiteam-form-grid">'
      + '<input type="text" name="provider_key" placeholder="provider key 如 newapi-openai" required />'
      + '<input type="text" name="display_name" placeholder="显示名" />'
      + '<input type="text" name="base_url" placeholder="base_url 如 https://x/v1" />'
      + '<input type="password" name="api_key" placeholder="api_key" />'
      + '<select name="transport">'
      + '<option value="openai_chat">openai_chat</option>'
      + '<option value="codex_responses">codex_responses</option>'
      + '<option value="anthropic_messages">anthropic_messages</option>'
      + '</select>'
      + '<button class="aiteam-btn aiteam-btn-primary" type="submit">创建</button>'
      + '</form></section>'
      + '<section class="aiteam-llm-list">' + list + '</section>'
      + '</div>';
  }

  ns.pages.adminLlmProviders = {
    init: function (container) {
      if (!container) return;
      var role = ns.role ? ns.role.getActiveRole() : '';
      if (role && (!ns.role || !ns.role.hasPermission || !ns.role.hasPermission(role, 'manage_employees'))) {
        renderPermissionDenied(container);
        return;
      }
      createController(container).load();
    },
    __test: {
      renderProviderCard: renderProviderCard,
      renderPage: renderPage,
    }
  };

  // controller defined in second IIFE block below (attached via ns._llmController)
  function createController(container) {
    return ns._llmController(container, { renderPage: renderPage, esc: esc });
  }
}(window.aiteam));

(function registerLlmController(ns) {
  ns._llmController = function (container, helpers) {
    var state = { providers: [], notice: '' };

    function setNotice(msg) { state.notice = msg || ''; render(); }

    function render() {
      container.innerHTML = helpers.renderPage(state);
      bind();
    }

    function load() {
      if (!ns.api || !ns.api.getLlmProviders) {
        container.innerHTML = '<div class="aiteam-state">API client 未接入 getLlmProviders</div>';
        return;
      }
      ns.api.getLlmProviders().then(function (res) {
        state.providers = (res && res.data && res.data.providers) || [];
        render();
      });
    }

    function bind() {
      var createForm = container.querySelector('[data-role="llm-create-provider-form"]');
      if (createForm) {
        createForm.addEventListener('submit', function (e) {
          e.preventDefault();
          var f = e.target;
          var payload = {
            provider_key: f.provider_key.value.trim(),
            display_name: f.display_name.value.trim(),
            base_url: f.base_url.value.trim(),
            api_key: f.api_key.value,
            transport: f.transport.value,
          };
          if (!payload.provider_key) { setNotice('provider key 必填'); return; }
          ns.api.createLlmProvider(payload).then(function (res) {
            if (res && res.ok) { setNotice('Provider 已创建'); load(); }
            else { setNotice('创建失败: ' + ((res && res.data && res.data.message) || (res && res.error) || '未知错误')); }
          });
        });
      }

      container.querySelectorAll('[data-role="llm-add-model-form"]').forEach(function (form) {
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var f = e.target;
          var pid = form.getAttribute('data-provider');
          var payload = {
            model_id: f.model_id.value.trim(),
            label: f.label.value.trim(),
            context_length: parseInt(f.context_length.value, 10) || 0,
            is_default: !!f.is_default.checked,
          };
          if (!payload.model_id) { setNotice('模型ID 必填'); return; }
          ns.api.addLlmModel(pid, payload).then(function (res) {
            if (res && res.ok) { setNotice('模型已添加'); load(); }
            else { setNotice('添加失败: ' + ((res && res.data && res.data.message) || (res && res.error) || '未知错误')); }
          });
        });
      });

      container.querySelectorAll('[data-role="llm-del-provider"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var pid = btn.getAttribute('data-provider');
          if (typeof window !== 'undefined' && window.confirm && !window.confirm('确认删除该 Provider 及其模型?')) return;
          ns.api.deleteLlmProvider(pid).then(function (res) {
            if (res && res.ok) { setNotice('Provider 已删除'); load(); }
            else { setNotice('删除失败'); }
          });
        });
      });

      container.querySelectorAll('[data-role="llm-del-model"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var mid = btn.getAttribute('data-model');
          ns.api.deleteLlmModel(mid).then(function (res) {
            if (res && res.ok) { setNotice('模型已删除'); load(); }
            else { setNotice('删除失败'); }
          });
        });
      });
    }

    return { load: load, __state: state };
  };
}(window.aiteam));

