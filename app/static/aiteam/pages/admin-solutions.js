window.aiteam = window.aiteam || {};

(function registerAdminSolutionsPage(ns) {
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

  function normalizeItems(payload) {
    if (!payload) return [];
    if (Array.isArray(payload.items)) return payload.items.slice();
    if (Array.isArray(payload.solutions)) return payload.solutions.slice();
    if (Array.isArray(payload)) return payload.slice();
    return [];
  }

  function normalizeTags(value) {
    if (!Array.isArray(value)) return [];
    return value.map(function (item) { return String(item || '').replace(/^\s+|\s+$/g, ''); }).filter(function (item) { return !!item; });
  }

  function normalizeSolution(item) {
    var stats = item && item.solution_stats || {};
    return {
      solution_id: stringValue(item && (item.solution_id || item.id), ''),
      name: stringValue(item && item.name, '未命名方案'),
      status: stringValue(item && item.status, 'draft'),
      tags: normalizeTags(item && item.tags),
      template_ids: Array.isArray(item && item.template_ids) ? item.template_ids.slice() : [],
      apply_count: Number(item && (item.apply_count != null ? item.apply_count : stats.apply_count)) || 0,
      active_employee_count: Number(item && (item.active_employee_count != null ? item.active_employee_count : stats.active_employee_count)) || 0,
      template_count: Number(item && (item.template_count != null ? item.template_count : stats.template_count)) || 0,
      description: stringValue(item && item.description, '暂无方案描述'),
      expected_value: stringValue(item && (item.expected_value || item.expected_value_summary), ''),
      default_skill_bundle: item && item.default_skill_bundle,
      default_kb_blueprint: item && item.default_kb_blueprint,
      template_summaries: Array.isArray(item && item.template_summaries) ? item.template_summaries.slice() : [],
      publish_record: item && item.publish_record || null,
      last_apply_record_id: stringValue(item && item.last_apply_record_id, ''),
      last_apply_status: stringValue(item && item.last_apply_status, ''),
      created_employee_ids: Array.isArray(item && item.created_employee_ids) ? item.created_employee_ids.slice() : [],
      created_knowledge_base_ids: Array.isArray(item && item.created_knowledge_base_ids) ? item.created_knowledge_base_ids.slice() : [],
    };
  }

  function renderPermissionDenied(container) {
    if (ns.states && ns.states.renderPermissionDenied) {
      ns.states.renderPermissionDenied(container);
    } else {
      container.innerHTML = '<div class="aiteam-state aiteam-state-denied"><p>您没有权限访问此内容</p></div>';
    }
  }

  function apiErrorMessage(result) {
    if (result && result.status === 403) return '您没有权限应用行业方案';
    if (result && result.status === 404) return '行业方案服务暂时不可用';
    if (result && result.status === 501) return '行业方案服务暂时不可用';
    if (result && result.error) return result.error;
    if (result && typeof result.status !== 'undefined') return '请求失败 (' + result.status + ')';
    return '网络请求失败';
  }

  function applyModeLabel(mode) {
    if (mode === 'replace') return '覆盖重建';
    if (mode === 'reapply') return '重新应用';
    return '追加应用';
  }

  function expectedValueText(item) {
    if (item && item.expected_value) return item.expected_value;
    if (item && item.tags && item.tags.length) return '预期帮助企业在 ' + item.tags.join(' / ') + ' 场景下缩短落地时间并稳定复用模板能力。';
    return '预期帮助企业快速落地一套可复用的行业 AI 协作能力。';
  }

  function renderTemplatePreview(item) {
    var templates = Array.isArray(item && item.template_summaries) ? item.template_summaries : [];
    if (!templates.length) {
      return '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">待创建员工预览</span><span class="aiteam-shell__meta-value">当前方案尚未返回模板预览</span></div>';
    }
    return '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">待创建员工预览</span><span class="aiteam-shell__meta-value">' +
      templates.map(function (template) {
        var modelRef = template && template.default_model_ref ? template.default_model_ref : {};
        var modelName = stringValue(modelRef.model, '未配置模型');
        return stringValue(template.name, '未命名员工') + ' / ' +
          stringValue(template.role_name, '未设置角色') + ' / ' +
          modelName;
      }).join('； ') + '</span></div>';
  }

  function renderApplyPreview(item, payload) {
    if (!item || !payload) return '';
    var templates = Array.isArray(item.template_summaries) ? item.template_summaries : [];
    var previewItems = templates.length
      ? templates.map(function (template) {
          var modelRef = template && template.default_model_ref ? template.default_model_ref : {};
          return '<li><strong>' + esc(stringValue(template.name, '未命名员工')) + '</strong> · ' +
            esc(stringValue(template.role_name, '未设置角色')) + ' · ' +
            esc(stringValue(modelRef.model, '未配置模型')) + '</li>';
        }).join('')
      : '<li>当前方案尚未返回模板预览</li>';
    return '' +
      '<div class="aiteam-state aiteam-state-empty" data-role="solution-apply-preview">' +
      '<p><strong>应用前确认</strong></p>' +
      '<p>即将以 <strong>' + esc(applyModeLabel(payload.mode)) + '</strong> 模式应用 <strong>' + esc(item.name || '未命名方案') + '</strong>。</p>' +
      '<p>目标部门：' + esc(stringValue(payload.department_id, '未指定')) + '</p>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">待创建员工预览</span><span class="aiteam-shell__meta-value"><ul>' + previewItems + '</ul></span></div>' +
      '<div class="aiteam-action-row">' +
      '<button type="button" class="aiteam-btn" data-role="solution-confirm-apply">确认应用</button>' +
      '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="solution-cancel-preview">取消</button>' +
      '</div>' +
      '</div>';
  }

  function createController(container) {
    var state = {
      items: [],
      notice: '',
      pendingSolutionId: '',
      pendingMode: '',
      lastSubmittedMode: '',
      lastApplyResult: null,
      previewSolutionId: '',
      previewPayload: null,
      openSolutionId: '',
    };

    function setNotice(message) {
      state.notice = message || '';
    }

    function findSolution(solutionId) {
      for (var i = 0; i < state.items.length; i++) {
        if (state.items[i].solution_id === solutionId) return state.items[i];
      }
      return null;
    }

    function clearPreview() {
      state.previewSolutionId = '';
      state.previewPayload = null;
    }

    // 应用结果只提示提交动作；新建/归档员工等以刷新后的后端清单为准，
    // 避免把 apply 响应里的临时 ID 残留在界面上。
    function summarizeApplyResult(data, mode, solutionId) {
      return '行业方案应用已提交：' + solutionId + '（' + applyModeLabel(mode) + '）';
    }

    function upsertSolution(solutionId, patch) {
      var next = [];
      var found = false;
      for (var i = 0; i < state.items.length; i++) {
        if (state.items[i].solution_id === solutionId) {
          next.push(normalizeSolution(Object.assign({}, state.items[i], patch || {}, { solution_id: solutionId })));
          found = true;
        } else {
          next.push(state.items[i]);
        }
      }
      if (!found) next.unshift(normalizeSolution(Object.assign({ solution_id: solutionId }, patch || {})));
      state.items = next;
    }

    function renderNotReady(result) {
      container.innerHTML =
        '<div class="aiteam-shell__panel">' +
        '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
        '<h2 class="aiteam-shell__panel-title">行业 AI 解决方案</h2>' +
        '<p class="aiteam-shell__panel-body">行业方案数据暂时无法加载，请稍后刷新重试。</p>' +
        '<div class="aiteam-shell__meta">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">当前状态</span><span class="aiteam-shell__meta-value">' + esc(apiErrorMessage(result)) + '</span></div>' +
        '</div>' +
        '</div>';
    }

    // Slim list row: name + one-line description + status badge. Full detail and
    // the apply controls live in a modal opened on click.
    function renderRow(item) {
      var isApplied = item.apply_count > 0 || item.last_apply_status === 'succeeded';
      var badge = isApplied
        ? '<span class="aiteam-badge">已应用</span>'
        : '<span class="aiteam-badge aiteam-badge--muted">' + esc(item.status) + '</span>';
      return '<button type="button" class="aiteam-list-row" data-solution-open="' + esc(item.solution_id) + '">' +
        '<span class="aiteam-list-row__icon">🏭</span>' +
        '<span class="aiteam-list-row__main">' +
        '<span class="aiteam-list-row__title">' + esc(item.name) + '</span>' +
        '<span class="aiteam-list-row__desc">' + esc(item.description) + '</span>' +
        '</span>' +
        '<span class="aiteam-list-row__aside">' + badge + '</span>' +
        '</button>';
    }

    function renderDetailModal(item) {
      if (!item) return '';
      var tags = item.tags.length ? item.tags.join(' / ') : '无标签';
      var createdEmployees = item.created_employee_ids.length ? item.created_employee_ids.join(', ') : '尚无最近应用结果';
      var createdKnowledge = item.created_knowledge_base_ids.length ? item.created_knowledge_base_ids.join(', ') : '—';
      var publishRecord = item.publish_record && item.publish_record.created_at
        ? ('最近发布：' + item.publish_record.created_at)
        : '暂无发布记录';
      var lastApplyStatus = item.last_apply_status ? item.last_apply_status : '尚无最近应用记录';
      var lastApplyRecord = item.last_apply_record_id ? item.last_apply_record_id : '—';
      var isApplied = item.apply_count > 0 || lastApplyStatus === 'succeeded';
      var appliedBadge = isApplied ? ' <span class="aiteam-badge">已应用</span>' : '';
      var pending = state.pendingSolutionId === item.solution_id;
      var disabled = pending ? ' disabled' : '';
      var primaryMode = isApplied ? 'reapply' : 'append';
      var primaryLabel = isApplied ? '重新应用' : '追加应用';
      var showPreview = state.previewSolutionId === item.solution_id;
      return '<div class="aiteam-modal__overlay" data-solution-modal>' +
        '<div class="aiteam-modal aiteam-solution-modal" role="dialog">' +
        '<button type="button" class="aiteam-drawer__close aiteam-modal__close" data-solution-modal-close>×</button>' +
        '<h3 class="aiteam-modal__title">🏭 ' + esc(item.name) + appliedBadge + '</h3>' +
        '<p class="aiteam-modal__sub">' + esc(item.description) + '</p>' +
        '<div class="aiteam-skill-card__meta">状态：' + esc(item.status) + ' · 标签：' + esc(tags) + '</div>' +
        '<div class="aiteam-skill-card__meta">模板数：' + esc(item.template_count) + ' · 已应用：' + esc(item.apply_count) + ' · 激活员工：' + esc(item.active_employee_count) + '</div>' +
        '<div class="aiteam-skill-card__meta">' + esc(publishRecord) + '</div>' +
        '<div class="aiteam-shell__meta">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">包含 AI 员工（专家）</span><span class="aiteam-shell__meta-value">' + esc(item.template_ids.join(', ') || '待绑定模板') + '</span></div>' +
        renderTemplatePreview(item) +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">预期价值</span><span class="aiteam-shell__meta-value">' + esc(expectedValueText(item)) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">原子回滚</span><span class="aiteam-shell__meta-value">失败时整体回滚，不保留局部创建结果</span></div>' +
        '</div>' +
        '<div class="aiteam-shell__meta">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">最近应用状态</span><span class="aiteam-shell__meta-value">' + esc(lastApplyStatus) + '（记录 ' + esc(lastApplyRecord) + '）</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">最近应用员工</span><span class="aiteam-shell__meta-value">' + esc(createdEmployees) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">最近创建知识库</span><span class="aiteam-shell__meta-value">' + esc(createdKnowledge) + '</span></div>' +
        '</div>' +
        (showPreview ? renderApplyPreview(item, state.previewPayload) : '') +
        '<div class="aiteam-skill-card__actions">' +
        '<button type="button" class="aiteam-btn" data-role="solution-apply" data-mode="' + esc(primaryMode) + '" data-solution-id="' + esc(item.solution_id) + '"' + disabled + '>' + esc(primaryLabel) + '</button>' +
        '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="solution-apply" data-mode="replace" data-solution-id="' + esc(item.solution_id) + '"' + disabled + '>覆盖重建</button>' +
        (isApplied
          ? '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="solution-apply" data-mode="append" data-solution-id="' + esc(item.solution_id) + '"' + disabled + '>追加应用</button>'
          : '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="solution-apply" data-mode="reapply" data-solution-id="' + esc(item.solution_id) + '"' + disabled + '>重新应用</button>') +
        '</div>' +
        (pending ? '<div class="aiteam-skill-card__meta">正在提交：' + esc(applyModeLabel(state.pendingMode)) + '</div>' : '') +
        '</div>' +
        '</div>';
    }

    function bindEvents() {
      if (!container || !container.querySelectorAll) return;
      var openButtons = container.querySelectorAll('[data-solution-open]');
      for (var o = 0; o < openButtons.length; o++) {
        openButtons[o].addEventListener('click', function () {
          container.lastOpenHandler(this.getAttribute('data-solution-open') || '');
        });
      }
      var modalClose = container.querySelector ? container.querySelector('[data-solution-modal-close]') : null;
      if (modalClose && typeof modalClose.addEventListener === 'function') {
        modalClose.addEventListener('click', function () { container.lastCloseHandler(); });
      }
      var modalOverlay = container.querySelector ? container.querySelector('[data-solution-modal]') : null;
      if (modalOverlay && typeof modalOverlay.addEventListener === 'function') {
        modalOverlay.addEventListener('click', function (event) {
          var target = event && event.target ? event.target : null;
          if (!target || target === modalOverlay) container.lastCloseHandler();
        });
      }
      var buttons = container.querySelectorAll('[data-role="solution-apply"]');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].addEventListener('click', function () {
          var solutionId = this.getAttribute('data-solution-id');
          var mode = String(this.getAttribute('data-mode') || 'append');
          var defaultDept = '';
          var departmentId = typeof window.prompt === 'function'
            ? window.prompt('请输入目标部门 ID（可留空）', defaultDept)
            : defaultDept;
          if (departmentId === null) return;
          var payload = {
            mode: mode,
            department_id: String(departmentId || '').replace(/^\s+|\s+$/g, ''),
            idempotency_key: 'solution-apply-' + solutionId + '-' + mode,
          };
          container.lastPreviewHandler(solutionId, payload);
        });
      }
      var confirmButton = container.querySelector ? container.querySelector('[data-role="solution-confirm-apply"]') : null;
      if (confirmButton && typeof confirmButton.addEventListener === 'function') {
        confirmButton.addEventListener('click', function () {
          container.lastConfirmApplyHandler();
        });
      }
      var cancelButton = container.querySelector ? container.querySelector('[data-role="solution-cancel-preview"]') : null;
      if (cancelButton && typeof cancelButton.addEventListener === 'function') {
        cancelButton.addEventListener('click', function () {
          container.lastCancelPreviewHandler();
        });
      }
    }

    function render() {
      var rows = state.items.length
        ? state.items.map(renderRow).join('')
        : '<div class="aiteam-inline-empty">当前企业暂无可应用方案</div>';
      container.innerHTML =
        '<div class="aiteam-shell__panel">' +
        '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
        '<h2 class="aiteam-shell__panel-title">行业 AI 解决方案</h2>' +
        '<p class="aiteam-shell__panel-body">按行业一键应用预设的数字员工方案。点击方案查看详情并应用——支持追加应用、覆盖重建与重新应用三种模式，应用后自动创建对应的员工与知识库。</p>' +
        (state.notice ? '<div class="aiteam-state aiteam-state-empty"><p>' + esc(state.notice) + '</p></div>' : '') +
        '<div class="aiteam-shell__meta">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">应用模式</span><span class="aiteam-shell__meta-value">追加应用 / 覆盖重建 / 重新应用</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">失败保护</span><span class="aiteam-shell__meta-value">应用失败时自动整体回滚，不会产生不完整的配置</span></div>' +
        (state.lastSubmittedMode ? '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">最近一次提交</span><span class="aiteam-shell__meta-value">' + esc(applyModeLabel(state.lastSubmittedMode)) + '</span></div>' : '') +
        '</div>' +
        (state.lastSubmittedMode ? '<p class="aiteam-shell__panel-body">最近一次提交：' + esc(applyModeLabel(state.lastSubmittedMode)) + '</p>' : '') +
        (state.lastApplyResult ? '<p class="aiteam-shell__panel-body">' + esc(state.lastApplyResult) + '</p>' : '') +
        '<div class="aiteam-list aiteam-solution-list">' + rows + '</div>' +
        '<div class="aiteam-shell__panel-body">没有我的行业？告诉我们：提交你的业务场景，我们会补充对应的行业 AI 解决方案。</div>' +
        '</div>' +
        (state.openSolutionId ? renderDetailModal(findSolution(state.openSolutionId)) : '');
      bindEvents();
    }

    function refreshList(options) {
      var config = options || {};
      return ns.api.getSolutions().then(function (result) {
        if (!result.ok) {
          if (config.errorNotice) setNotice(config.errorNotice + apiErrorMessage(result));
          render();
          return result;
        }
        state.items = normalizeItems(result.data).map(normalizeSolution);
        if (config.notice !== undefined) setNotice(config.notice);
        render();
        return result;
      });
    }

    container.lastApplyHandler = function (solutionId, payload) {
      if (!ns.api || !ns.api.applySolution) {
        setNotice('当前 API client 未接入 applySolution');
        render();
        return Promise.resolve({ ok: false, status: 0, error: 'missing_applySolution' });
      }
      clearPreview();
      state.pendingSolutionId = solutionId;
      state.pendingMode = String(payload && payload.mode || 'append');
      setNotice('');
      render();
      return ns.api.applySolution(solutionId, payload || {}).then(function (result) {
        state.pendingSolutionId = '';
        state.lastSubmittedMode = state.pendingMode;
        state.pendingMode = '';
        if (result && result.ok) {
          state.lastApplyResult = summarizeApplyResult(result.data, state.lastSubmittedMode, solutionId);
          return refreshList({
            notice: state.lastApplyResult,
            errorNotice: '行业方案应用成功，但列表刷新失败：',
          }).then(function () {
            return result;
          });
        }
        state.lastApplyResult = null;
        setNotice('行业方案应用失败：' + apiErrorMessage(result));
        render();
        return result;
      });
    };

    container.lastPreviewHandler = function (solutionId, payload) {
      state.previewSolutionId = solutionId;
      state.previewPayload = Object.assign({}, payload || {});
      // Apply controls live inside the detail modal, so previewing always
      // implies that solution's modal is open.
      state.openSolutionId = solutionId;
      setNotice('');
      render();
      return Promise.resolve({ ok: true, preview: true });
    };

    container.lastConfirmApplyHandler = function () {
      if (!state.previewSolutionId || !state.previewPayload) {
        return Promise.resolve({ ok: false, status: 0, error: 'missing_preview' });
      }
      return container.lastApplyHandler(state.previewSolutionId, state.previewPayload);
    };

    container.lastCancelPreviewHandler = function () {
      clearPreview();
      render();
      return Promise.resolve({ ok: true, cancelled: true });
    };

    container.lastOpenHandler = function (solutionId) {
      state.openSolutionId = solutionId || '';
      clearPreview();
      render();
      return Promise.resolve({ ok: true, opened: solutionId });
    };

    container.lastCloseHandler = function () {
      state.openSolutionId = '';
      clearPreview();
      render();
      return Promise.resolve({ ok: true, closed: true });
    };

    function load() {
      if (ns.states && ns.states.renderLoading) ns.states.renderLoading(container);
      else container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载行业方案...</p></div>';
      refreshList().then(function (result) {
        if (!result.ok) {
          renderNotReady(result);
        }
      });
    }

    return { load: load };
  }

  ns.pages.adminSolutions = {
    init: function (container) {
      if (!container) return;
      var role = ns.role ? ns.role.getActiveRole() : '';
      if (role === 'finance_admin' || role === 'member') {
        renderPermissionDenied(container);
        return;
      }
      if (!ns.api || !ns.api.getSolutions) {
        container.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>行业方案 API client 未加载</p></div>';
        return;
      }
      createController(container).load();
    },
  };
}(window.aiteam));
