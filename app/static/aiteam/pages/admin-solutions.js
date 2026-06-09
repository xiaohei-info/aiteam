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
      default_skill_bundle: item && item.default_skill_bundle,
      default_kb_blueprint: item && item.default_kb_blueprint,
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
    if (result && result.status === 404) return '行业方案接口尚未开放';
    if (result && result.status === 501) return '行业方案接口尚未实现';
    if (result && result.error) return result.error;
    if (result && typeof result.status !== 'undefined') return '请求失败 (' + result.status + ')';
    return '网络请求失败';
  }

  function applyModeLabel(mode) {
    if (mode === 'replace') return '覆盖重建';
    if (mode === 'reapply') return '重新应用';
    return '追加应用';
  }

  function createController(container) {
    var state = {
      items: [],
      notice: '',
      pendingSolutionId: '',
      pendingMode: '',
      lastSubmittedMode: '',
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
        '<p class="aiteam-shell__panel-body">B06 页面已按企业口径对接 `/api/team/solutions` 与 `POST /api/team/solutions/{id}/apply`。当前后端尚未开放列表接口时，页面保留 Apply 契约说明与原子回滚提示，不伪造已应用状态。</p>' +
        '<div class="aiteam-shell__meta">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">Apply 语义</span><span class="aiteam-shell__meta-value">append 模式，失败时整体回滚</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">当前状态</span><span class="aiteam-shell__meta-value">' + esc(apiErrorMessage(result)) + '</span></div>' +
        '</div>' +
        '</div>';
    }

    function renderCard(item) {
      var tags = item.tags.length ? item.tags.join(' / ') : '无标签';
      var createdEmployees = item.created_employee_ids.length ? item.created_employee_ids.join(', ') : '尚无最近应用结果';
      var createdKnowledge = item.created_knowledge_base_ids.length ? item.created_knowledge_base_ids.join(', ') : '—';
      var publishRecord = item.publish_record && item.publish_record.created_at
        ? ('最近发布：' + item.publish_record.created_at)
        : '暂无发布记录';
      var lastApplyStatus = item.last_apply_status ? item.last_apply_status : '尚无最近应用记录';
      var lastApplyRecord = item.last_apply_record_id ? item.last_apply_record_id : '—';
      var pending = state.pendingSolutionId === item.solution_id;
      var disabled = pending ? ' disabled' : '';
      return '<li class="aiteam-skill-card">' +
        '<div class="aiteam-skill-card__title">' + esc(item.name) + '</div>' +
        '<div class="aiteam-skill-card__meta">状态：' + esc(item.status) + ' · 标签：' + esc(tags) + '</div>' +
        '<div class="aiteam-skill-card__meta">模板数：' + esc(item.template_count) + ' · 已应用：' + esc(item.apply_count) + ' · 激活员工：' + esc(item.active_employee_count) + '</div>' +
        '<div class="aiteam-skill-card__meta">绑定模板：' + esc(item.template_ids.join(', ') || '未绑定') + '</div>' +
        '<div class="aiteam-skill-card__meta">' + esc(publishRecord) + '</div>' +
        '<div class="aiteam-shell__meta">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">最近应用状态</span><span class="aiteam-shell__meta-value">' + esc(lastApplyStatus) + '（记录 ' + esc(lastApplyRecord) + '）</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">最近应用员工</span><span class="aiteam-shell__meta-value">' + esc(createdEmployees) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">最近创建知识库</span><span class="aiteam-shell__meta-value">' + esc(createdKnowledge) + '</span></div>' +
        '</div>' +
        '<div class="aiteam-skill-card__actions">' +
        '<button type="button" class="aiteam-btn" data-role="solution-apply" data-mode="append" data-solution-id="' + esc(item.solution_id) + '"' + disabled + '>追加应用</button>' +
        '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="solution-apply" data-mode="replace" data-solution-id="' + esc(item.solution_id) + '"' + disabled + '>覆盖重建</button>' +
        '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="solution-apply" data-mode="reapply" data-solution-id="' + esc(item.solution_id) + '"' + disabled + '>重新应用</button>' +
        '</div>' +
        (pending ? '<div class="aiteam-skill-card__meta">正在提交：' + esc(applyModeLabel(state.pendingMode)) + '</div>' : '') +
        '</li>';
    }

    function bindEvents() {
      if (!container || !container.querySelectorAll) return;
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
          container.lastApplyHandler(solutionId, payload);
        });
      }
    }

    function render() {
      var cards = state.items.length
        ? state.items.map(renderCard).join('')
        : '<li class="aiteam-skill-card"><div class="aiteam-skill-card__meta">当前企业暂无可应用方案</div></li>';
      container.innerHTML =
        '<div class="aiteam-shell__panel">' +
        '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
        '<h2 class="aiteam-shell__panel-title">行业 AI 解决方案</h2>' +
        '<p class="aiteam-shell__panel-body">B06 页面通过 `/api/team/solutions` 读取企业可应用方案，并通过 `POST /api/team/solutions/{id}/apply` 提交。当前支持追加应用、覆盖重建、重新应用三种策略；方案创建新员工和知识库，页面展示的统计、最近应用状态、员工与知识库结果均以后端列表返回为准。</p>' +
        (state.notice ? '<div class="aiteam-state aiteam-state-empty"><p>' + esc(state.notice) + '</p></div>' : '') +
        '<div class="aiteam-shell__meta">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">应用模式</span><span class="aiteam-shell__meta-value">追加应用 / 覆盖重建 / 重新应用</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">原子性</span><span class="aiteam-shell__meta-value">若后端返回失败，则视为全量回滚，不展示局部成功</span></div>' +
        (state.lastSubmittedMode ? '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">最近一次提交</span><span class="aiteam-shell__meta-value">' + esc(applyModeLabel(state.lastSubmittedMode)) + '</span></div>' : '') +
        '</div>' +
        (state.lastSubmittedMode ? '<p class="aiteam-shell__panel-body">最近一次提交：' + esc(applyModeLabel(state.lastSubmittedMode)) + '</p>' : '') +
        '<ul class="aiteam-skills-list">' + cards + '</ul>' +
        '</div>';
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
      state.pendingSolutionId = solutionId;
      state.pendingMode = String(payload && payload.mode || 'append');
      setNotice('');
      render();
      return ns.api.applySolution(solutionId, payload || {}).then(function (result) {
        state.pendingSolutionId = '';
        state.lastSubmittedMode = state.pendingMode;
        state.pendingMode = '';
        if (result && result.ok) {
          return refreshList({
            notice: '行业方案应用已提交：' + solutionId + '（' + applyModeLabel(state.lastSubmittedMode) + '）',
            errorNotice: '行业方案应用成功，但列表刷新失败：',
          }).then(function () {
            return result;
          });
        }
        setNotice('行业方案应用失败：' + apiErrorMessage(result));
        render();
        return result;
      });
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
