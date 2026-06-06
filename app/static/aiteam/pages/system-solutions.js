window.aiteam = window.aiteam || {};

(function registerSystemSolutionsPage(ns) {
  ns.pages = ns.pages || {};

  function trimText(value) {
    if (value === undefined || value === null) return '';
    return String(value).replace(/^\s+|\s+$/g, '');
  }

  function normalizeItems(payload) {
    if (Array.isArray(payload)) return payload.slice();
    if (payload && Array.isArray(payload.items)) return payload.items.slice();
    if (payload && Array.isArray(payload.solutions)) return payload.solutions.slice();
    return [];
  }

  function normalizeTemplateIds(templateIds) {
    if (!Array.isArray(templateIds)) return [];
    var values = [];
    for (var i = 0; i < templateIds.length; i++) {
      var value = trimText(templateIds[i]);
      if (value) values.push(value);
    }
    return values;
  }

  function mergeSolutionRecord(current, incoming) {
    return Object.assign({}, current || {}, incoming || {});
  }

  function findSolution(items, solutionId) {
    var list = Array.isArray(items) ? items : [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      if ((item.solution_id || item.id) === solutionId) return item;
    }
    return null;
  }

  function upsertSolution(items, solutionId, patch) {
    var list = Array.isArray(items) ? items.slice() : [];
    var merged = false;
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      var currentId = item.solution_id || item.id;
      if (currentId === solutionId) {
        list[i] = mergeSolutionRecord(item, patch);
        merged = true;
        break;
      }
    }
    if (!merged) {
      list.unshift(mergeSolutionRecord({ solution_id: solutionId }, patch));
    }
    return list;
  }

  function renderNotImplemented(container) {
    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
      '<h2 class="aiteam-shell__panel-title">行业方案管理</h2>' +
      '<p class="aiteam-shell__panel-body">行业方案治理 API 尚未实现（当前返回 501）。此区域已对接 `/api/system-admin/solutions`，后端就绪后将承接方案发布、模板绑定与应用统计。</p>' +
      '<div class="aiteam-shell__meta">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">主读取接口</span><span class="aiteam-shell__meta-value">GET /api/system-admin/solutions</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">后续写接口</span><span class="aiteam-shell__meta-value">POST /api/system-admin/solutions · PATCH /api/system-admin/solutions/{id}</span></div>' +
      '</div>' +
      '</div>';
  }

  function renderPanel(container, state) {
    var items = normalizeItems(state && state.items);
    var notice = state && state.notice ? state.notice : '';
    var rows = items.map(function (item) {
      var solutionId = item.solution_id || item.id || '';
      var status = item.status || item.publish_state || '';
      var templateIds = normalizeTemplateIds(item.template_ids || (item.solution_stats && item.solution_stats.template_ids) || []);
      var templateCount = item.template_count;
      if (typeof templateCount === 'undefined' && item.solution_stats && typeof item.solution_stats.template_count !== 'undefined') {
        templateCount = item.solution_stats.template_count;
      }
      if (typeof templateCount === 'undefined') templateCount = templateIds.length;
      var applyCount = item.apply_count;
      if (typeof applyCount === 'undefined' && item.solution_stats && typeof item.solution_stats.apply_count !== 'undefined') {
        applyCount = item.solution_stats.apply_count;
      }
      var publishLabel = status === 'published' ? '下架' : '发布';
      var publishAction = status === 'published' ? 'unpublish' : 'publish';
      return '<tr>' +
        '<td>' + solutionId + '</td>' +
        '<td>' + (item.name || '') + '</td>' +
        '<td>' + status + '</td>' +
        '<td>' + templateCount + '</td>' +
        '<td>' + (typeof applyCount === 'undefined' ? '-' : applyCount) + '</td>' +
        '<td>' + (templateIds.length ? templateIds.join(', ') : '未绑定') + '</td>' +
        '<td>' +
          '<button class="aiteam-btn aiteam-btn--sm" data-aiteam-action="update" data-aiteam-solution-id="' + solutionId + '">更新</button> ' +
          '<button class="aiteam-btn aiteam-btn--sm" data-aiteam-action="bind" data-aiteam-solution-id="' + solutionId + '">绑定模板</button> ' +
          '<button class="aiteam-btn aiteam-btn--sm" data-aiteam-action="' + publishAction + '" data-aiteam-solution-id="' + solutionId + '">' + publishLabel + '</button>' +
        '</td>' +
        '</tr>';
    }).join('');

    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
      '<h2 class="aiteam-shell__panel-title">行业方案管理</h2>' +
      '<p class="aiteam-shell__panel-body">通过 `/api/system-admin/solutions` 消费平台行业方案治理视图，并提供最小创建、更新、发布和模板绑定入口。</p>' +
      (notice ? '<div class="aiteam-state aiteam-state-empty"><p>' + notice + '</p></div>' : '') +
      '<form class="aiteam-shell__meta" data-aiteam-solution-create-form="1">' +
      '<div class="aiteam-shell__meta-card"><label>方案名称<br><input class="aiteam-input" type="text" data-aiteam-solution-create-name="1" placeholder="例如：零售标准方案"></label></div>' +
      '<div class="aiteam-shell__meta-card"><label>模板 ID（逗号分隔）<br><input class="aiteam-input" type="text" data-aiteam-solution-create-templates="1" placeholder="例如：tpl_ops, tpl_sales"></label></div>' +
      '<div class="aiteam-shell__meta-card"><label><input type="checkbox" data-aiteam-solution-create-publish="1"> 创建后立即发布</label><br><button type="submit" class="aiteam-btn aiteam-btn--sm">新建方案</button></div>' +
      '</form>' +
      '<div class="aiteam-shell__meta">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">新建方案</span><span class="aiteam-shell__meta-value">输入方案名称与模板 ID 后提交</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">行级治理</span><span class="aiteam-shell__meta-value">更新 / 绑定模板按钮使用最小提示输入；发布 / 下架直接提交</span></div>' +
      '</div>' +
      '<table class="aiteam-table"><thead><tr><th>ID</th><th>名称</th><th>状态</th><th>模板数</th><th>应用数</th><th>绑定模板</th><th>治理操作</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="7">暂无系统行业方案</td></tr>') +
      '</tbody></table>' +
      '</div>';
  }

  function bindPanelInteractions(container, state) {
    var createForm = container.querySelector ? container.querySelector('[data-aiteam-solution-create-form]') : null;
    if (createForm && createForm.addEventListener) {
      createForm.addEventListener('submit', function (event) {
        if (event && event.preventDefault) event.preventDefault();
        var nameInput = container.querySelector ? container.querySelector('[data-aiteam-solution-create-name]') : null;
        var templatesInput = container.querySelector ? container.querySelector('[data-aiteam-solution-create-templates]') : null;
        var publishInput = container.querySelector ? container.querySelector('[data-aiteam-solution-create-publish]') : null;
        var payload = {
          name: trimText(nameInput && nameInput.value),
          template_ids: normalizeTemplateIds(trimText(templatesInput && templatesInput.value).split(','))
        };
        if (publishInput && publishInput.checked) payload.publish_action = 'publish';
        if (!payload.name) return;
        container.lastCreateHandler(payload).then(function (result) {
          if (result && result.ok) {
            if (nameInput) nameInput.value = '';
            if (templatesInput) templatesInput.value = '';
            if (publishInput) publishInput.checked = false;
          }
        });
      });
    }

    var buttons = container.querySelectorAll ? container.querySelectorAll('button[data-aiteam-action][data-aiteam-solution-id]') : [];
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function (event) {
        var button = event && event.currentTarget ? event.currentTarget : this;
        var solutionId = button && button.getAttribute ? button.getAttribute('data-aiteam-solution-id') : '';
        var action = button && button.getAttribute ? button.getAttribute('data-aiteam-action') : '';
        if (!solutionId || !action) return;
        var current = findSolution(state.items, solutionId) || {};
        if (action === 'update') {
          var nextName = typeof window.prompt === 'function' ? window.prompt('请输入方案名称', current.name || '') : current.name;
          if (nextName === null) return;
          var nextBundle = typeof window.prompt === 'function' ? window.prompt('请输入默认技能包（可留空）', current.default_skill_bundle || '') : (current.default_skill_bundle || '');
          if (nextBundle === null) return;
          container.lastUpdateHandler(solutionId, {
            name: trimText(nextName),
            default_skill_bundle: trimText(nextBundle)
          });
          return;
        }
        if (action === 'bind') {
          var currentTemplates = normalizeTemplateIds(current.template_ids || []).join(', ');
          var nextTemplates = typeof window.prompt === 'function' ? window.prompt('请输入模板 ID，使用逗号分隔', currentTemplates) : currentTemplates;
          if (nextTemplates === null) return;
          container.lastBindHandler(solutionId, nextTemplates.split(','));
          return;
        }
        container.lastPublishHandler(solutionId, action);
      });
    }
  }

  ns.pages.systemSolutions = {
    init: function (container) {
      if (!container) return;

      container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载行业方案数据...</p></div>';

      var state = { items: [], notice: '' };

      function rerender(notice) {
        state.notice = notice || '';
        renderPanel(container, state);
        bindPanelInteractions(container, state);
      }

      container.lastCreateHandler = function (payload) {
        var request = payload || {};
        request.template_ids = normalizeTemplateIds(request.template_ids || []);
        return ns.api.post('/api/system-admin/solutions', request).then(function (result) {
          if (result && result.ok) {
            var created = mergeSolutionRecord(request, result.data || {});
            var solutionId = created.solution_id || created.id || request.solution_id || request.id || ('draft-' + (state.items.length + 1));
            state.items = upsertSolution(state.items, solutionId, created);
            rerender('系统行业方案已创建');
            return result;
          }
          rerender('系统行业方案创建失败');
          return result;
        });
      };

      container.lastUpdateHandler = function (solutionId, payload) {
        var request = payload || {};
        if (Object.prototype.hasOwnProperty.call(request, 'template_ids')) {
          request.template_ids = normalizeTemplateIds(request.template_ids);
        }
        return ns.api.patch('/api/system-admin/solutions/' + encodeURIComponent(solutionId), request).then(function (result) {
          if (result && result.ok) {
            state.items = upsertSolution(state.items, solutionId, mergeSolutionRecord(request, result.data || {}));
            rerender('系统行业方案已提交更新');
            return result;
          }
          rerender('系统行业方案更新失败');
          return result;
        });
      };

      container.lastBindHandler = function (solutionId, templateIds) {
        var request = { template_ids: normalizeTemplateIds(templateIds || []) };
        return ns.api.patch('/api/system-admin/solutions/' + encodeURIComponent(solutionId), request).then(function (result) {
          if (result && result.ok) {
            state.items = upsertSolution(state.items, solutionId, mergeSolutionRecord(result.data || {}, request));
            rerender('系统行业方案模板绑定已更新');
            return result;
          }
          rerender('系统行业方案模板绑定失败');
          return result;
        });
      };

      container.lastPublishHandler = function (solutionId, publishAction) {
        var action = trimText(publishAction) || 'publish';
        return ns.api.patch('/api/system-admin/solutions/' + encodeURIComponent(solutionId), { publish_action: action }).then(function (result) {
          if (result && result.ok) {
            state.items = upsertSolution(state.items, solutionId, mergeSolutionRecord(result.data || {}, {
              status: action === 'publish' ? 'published' : 'draft',
              publish_state: action === 'publish' ? 'published' : 'draft'
            }));
            rerender(action === 'publish' ? '系统行业方案已发布' : '系统行业方案已下架');
            return result;
          }
          rerender(action === 'publish' ? '系统行业方案发布失败' : '系统行业方案下架失败');
          return result;
        });
      };

      ns.api.get('/api/system-admin/solutions').then(function (result) {
        if (!result.ok) {
          if (result.status === 501) {
            renderNotImplemented(container);
            return;
          }
          if (ns.states && ns.states.handleApiResult) {
            ns.states.handleApiResult(result, container, function () {});
          } else {
            container.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>⚠ 行业方案数据加载失败</p></div>';
          }
          return;
        }
        state.items = normalizeItems(result.data);
        rerender('');
      });
    }
  };
}(window.aiteam));
