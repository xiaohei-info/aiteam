// admin-collaboration.js — enterprise群聊协作编排提示词配置
// Edits the enterprise default collaboration_template (planner/subtask/aggregate
// prompts). Empty fields fall back to the built-in defaults at runtime, so a
// blank textarea is valid and means "use default".
window.aiteam = window.aiteam || {};

(function registerAdminCollaborationPage(ns) {
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

  var FIELDS = [
    { key: 'planner_prompt', title: '规划提示词 (Planner)',
      hint: '主持人拆解子任务、分配成员的提示。' },
    { key: 'subtask_prompt', title: '子任务提示词 (Subtask)',
      hint: '每个成员执行其子任务时的提示。' },
    { key: 'aggregate_prompt', title: '汇总提示词 (Aggregate)',
      hint: '主持人把各成员结果汇总为最终交付的提示。' },
  ];

  function renderField(f, state) {
    var current = (state.template && state.template[f.key]) || '';
    var def = (state.defaults && state.defaults[f.key]) || '';
    var phs = (state.placeholders && state.placeholders[f.key]) || [];
    var chips = phs.map(function (p) {
      return '<code class="aiteam-tag">' + esc(p) + '</code>';
    }).join(' ');
    return '<section class="aiteam-card aiteam-collab-field">'
      + '<h3>' + esc(f.title) + '</h3>'
      + '<p class="aiteam-page-sub">' + esc(f.hint)
      + (chips ? ' 可用占位符: ' + chips : '') + '</p>'
      + '<textarea name="' + f.key + '" rows="6" class="aiteam-collab-textarea" '
      + 'placeholder="留空则使用默认模板">' + esc(current) + '</textarea>'
      + '<details class="aiteam-collab-default"><summary>查看默认模板</summary>'
      + '<pre>' + esc(def) + '</pre></details>'
      + '</section>';
  }

  function renderPage(state) {
    var fields = FIELDS.map(function (f) { return renderField(f, state); }).join('');
    var hasCustom = !!state.template;
    return '<div class="aiteam-page aiteam-collab-page">'
      + '<header class="aiteam-page-head"><h2>群聊协作编排</h2>'
      + '<p class="aiteam-page-sub">配置群聊多智能体协作的规划/子任务/汇总提示词。'
      + '留空的字段在运行时自动回退到内置默认模板。</p></header>'
      + (state.notice ? '<div class="aiteam-notice">' + esc(state.notice) + '</div>' : '')
      + '<div class="aiteam-collab-status">'
      + (hasCustom ? '当前已有自定义编排模板' : '当前使用全部默认模板')
      + '</div>'
      + '<form data-role="collab-form">'
      + '<input type="hidden" name="name" value="'
      + esc((state.template && state.template.name) || '默认编排') + '" />'
      + fields
      + '<div class="aiteam-collab-actions">'
      + '<button class="aiteam-btn aiteam-btn-primary" type="submit">保存</button>'
      + '</div></form>'
      + '</div>';
  }

  ns.pages.adminCollaboration = {
    init: function (container) {
      if (!container) return;
      var role = ns.role ? ns.role.getActiveRole() : '';
      if (role && (!ns.role || !ns.role.hasPermission || !ns.role.hasPermission(role, 'manage_employees'))) {
        renderPermissionDenied(container);
        return;
      }
      createController(container).load();
    },
    __test: { renderPage: renderPage, renderField: renderField }
  };

  function createController(container) {
    return ns._collabController(container, { renderPage: renderPage, esc: esc });
  }
}(window.aiteam));

(function registerCollabController(ns) {
  ns._collabController = function (container, helpers) {
    var state = { defaults: {}, placeholders: {}, template: null, notice: '' };

    function setNotice(msg) { state.notice = msg || ''; render(); }

    function render() {
      container.innerHTML = helpers.renderPage(state);
      bind();
    }

    function load() {
      if (!ns.api || !ns.api.getCollaborationTemplate) {
        container.innerHTML = '<div class="aiteam-state">API client 未接入 getCollaborationTemplate</div>';
        return;
      }
      ns.api.getCollaborationTemplate().then(function (res) {
        var d = (res && res.data) || {};
        state.defaults = d.defaults || {};
        state.placeholders = d.placeholders || {};
        state.template = d.template || null;
        render();
      });
    }

    function bind() {
      var form = container.querySelector('[data-role="collab-form"]');
      if (!form) return;
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target;
        var payload = {
          name: (f.name && f.name.value) || '默认编排',
          planner_prompt: f.planner_prompt.value,
          subtask_prompt: f.subtask_prompt.value,
          aggregate_prompt: f.aggregate_prompt.value,
        };
        ns.api.saveCollaborationTemplate(payload).then(function (res) {
          if (res && res.ok) { setNotice('编排模板已保存'); load(); }
          else { setNotice('保存失败: ' + ((res && res.data && res.data.message) || (res && res.error) || '未知错误')); }
        });
      });
    }

    return { load: load, __state: state };
  };
}(window.aiteam));
