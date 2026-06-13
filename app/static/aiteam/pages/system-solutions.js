window.aiteam = window.aiteam || {};

(function registerSystemSolutionsPage(ns) {
  ns.pages = ns.pages || {};

  function trimText(value) {
    if (value === undefined || value === null) return '';
    return String(value).replace(/^\s+|\s+$/g, '');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

  function scopeLabel(item) {
    var scope = item && item.publish_scope;
    if (!scope || scope.mode !== 'selected') return '全部可见';
    var ids = Array.isArray(scope.enterprise_ids) ? scope.enterprise_ids : [];
    return '指定企业 (' + ids.length + ')';
  }

  function renderSolutionCards(items, selectedId) {
    if (!items.length) {
      return '<div class="aiteam-inline-empty">暂无行业方案，点击右上角「创建方案」新建。</div>';
    }
    return '<div class="aiteam-stack">' + items.map(function (item) {
      var solutionId = item.solution_id || item.id || '';
      var tags = Array.isArray(item.tags) ? item.tags : [];
      var activeClass = solutionId && solutionId === selectedId ? ' is-active' : '';
      return '<button type="button" class="aiteam-card aiteam-card--selectable' + activeClass + '" data-aiteam-solution-preview="' + escapeHtml(solutionId) + '">' +
        '<div class="aiteam-card__row"><strong>' + escapeHtml(item.icon || '🏭') + ' ' + escapeHtml(item.name || '未命名方案') + '</strong><span class="aiteam-badge">' + escapeHtml(item.status || item.publish_state || 'draft') + '</span></div>' +
        '<div class="aiteam-card__meta"><span>模板数 ' + escapeHtml(item.template_count || normalizeTemplateIds(item.template_ids || []).length || 0) + '</span><span>应用数 ' + escapeHtml(item.apply_count || 0) + '</span></div>' +
        '<p class="aiteam-card__body">' + escapeHtml(item.description || '暂无方案描述') + '</p>' +
        '<div class="aiteam-card__meta"><span>' + escapeHtml(tags.length ? tags.join(' / ') : '无标签') + '</span></div>' +
        '</button>';
    }).join('') + '</div>';
  }

  function renderSolutionPreview(item) {
    if (!item) {
      return '<div class="aiteam-inline-empty">选择左侧的行业方案后，在此查看详情并进行治理操作。</div>';
    }
    var templateIds = normalizeTemplateIds(item.template_ids || []);
    var tags = Array.isArray(item.tags) ? item.tags : [];
    var solutionId = item.solution_id || item.id || '';
    var status = item.status || item.publish_state || 'draft';
    var publishLabel = status === 'published' ? '下架' : '发布';
    var publishAction = status === 'published' ? 'unpublish' : 'publish';
    return '' +
      '<div class="aiteam-detail-section">' +
      '<h3>方案详情</h3>' +
      '<div class="aiteam-chat-summary__hero">' +
      '<h3>' + escapeHtml(item.icon || '🏭') + ' ' + escapeHtml(item.name || '') + '</h3>' +
      '<p>' + escapeHtml(item.description || '暂无方案描述') + '</p>' +
      '</div>' +
      '<div class="aiteam-detail-kv">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">方案 ID</span><span class="aiteam-shell__meta-value">' + escapeHtml(solutionId) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">状态</span><span class="aiteam-shell__meta-value">' + escapeHtml(status) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">绑定模板</span><span class="aiteam-shell__meta-value">' + escapeHtml(templateIds.length ? templateIds.join(', ') : '未绑定') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">应用数</span><span class="aiteam-shell__meta-value">' + escapeHtml(item.apply_count || 0) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">发布范围</span><span class="aiteam-shell__meta-value">' + escapeHtml(scopeLabel(item)) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">标签</span><span class="aiteam-shell__meta-value">' + escapeHtml(tags.length ? tags.join(' / ') : '—') + '</span></div>' +
      '</div>' +
      '<div class="aiteam-detail-section__actions"><span class="aiteam-inline-note">治理操作</span>' +
      '<div class="aiteam-action-row">' +
      '<button class="aiteam-btn" data-aiteam-action="update" data-aiteam-solution-id="' + escapeHtml(solutionId) + '">更新方案</button>' +
      '<button class="aiteam-btn aiteam-btn--secondary" data-aiteam-action="bind" data-aiteam-solution-id="' + escapeHtml(solutionId) + '">绑定模板</button>' +
      '<button class="aiteam-btn aiteam-btn--secondary" data-aiteam-action="' + publishAction + '" data-aiteam-solution-id="' + escapeHtml(solutionId) + '">' + publishLabel + '</button>' +
      '</div>' +
      '</div>' +
      '</div>';
  }

  function renderNotImplemented(container) {
    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
      '<h2 class="aiteam-shell__panel-title">行业方案管理</h2>' +
      '<p class="aiteam-shell__panel-body">行业方案数据暂时不可用，请稍后刷新重试。</p>' +
      '</div>';
  }

  function renderPanel(container, state) {
    var items = normalizeItems(state && state.items);
    var notice = state && state.notice ? state.notice : '';
    // Default the detail pane to the first solution so its governance actions
    // (更新/绑定/发布) are reachable without a click; explicit selection wins.
    var previewSolution = findSolution(items, state && state.previewSolutionId) || items[0] || null;
    var selectedId = previewSolution ? (previewSolution.solution_id || previewSolution.id || '') : '';

    container.innerHTML =
      '<div class="aiteam-shell__panel aiteam-shell__panel--wide">' +
      '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
      '<h2 class="aiteam-shell__panel-title">行业方案管理</h2>' +
      '<p class="aiteam-shell__panel-body">管理面向企业的行业方案：创建方案、勾选专家模板、发布与下架，并控制每个方案发布给哪些企业。左侧选择方案，右侧查看详情并治理。</p>' +
      (notice ? '<div class="aiteam-state aiteam-state-empty"><p>' + escapeHtml(notice) + '</p></div>' : '') +
      '<div class="aiteam-shell__toolbar"><button type="button" class="aiteam-btn aiteam-btn--primary" data-aiteam-solution-create-open="1">➕ 创建方案</button></div>' +
      '<div class="aiteam-grid aiteam-grid--split">' +
      '<section class="aiteam-panel aiteam-panel--nested"><div class="aiteam-panel__header"><h3>方案列表</h3><span class="aiteam-inline-note">共 ' + items.length + ' 个</span></div>' + renderSolutionCards(items, selectedId) + '</section>' +
      '<section class="aiteam-panel aiteam-panel--nested">' + renderSolutionPreview(previewSolution) + '</section>' +
      '</div>' +
      '</div>';
  }

  // __PANEL_PLACEHOLDER__

  function renderEnterpriseCheckboxes(enterprises) {
    var list = Array.isArray(enterprises) ? enterprises : [];
    if (!list.length) {
      return '<p class="aiteam-drawer__desc">暂无企业可选（创建后可在更新中调整）。</p>';
    }
    return list.map(function (ent) {
      var id = ent.enterprise_id || ent.id || '';
      var name = ent.name || id;
      return '<label class="aiteam-drawer__check"><input type="checkbox" data-aiteam-scope-ent="' + escapeHtml(id) + '"> ' + escapeHtml(name) + ' <span class="aiteam-drawer__binding-meta">' + escapeHtml(id) + '</span></label>';
    }).join('');
  }

  function renderTemplateCheckboxes(templates) {
    var list = Array.isArray(templates) ? templates : [];
    if (!list.length) {
      return '<p class="aiteam-drawer__desc">暂无可选专家模板，请先在「专家管理」中创建。</p>';
    }
    return list.map(function (t) {
      var id = t.template_id || t.id || '';
      var name = t.name || id;
      var role = t.role_name || t.role || '';
      return '<label class="aiteam-drawer__check"><input type="checkbox" data-aiteam-tpl-pick="' + escapeHtml(id) + '"> ' + escapeHtml(name) + ' <span class="aiteam-drawer__binding-meta">' + escapeHtml(role || id) + '</span></label>';
    }).join('');
  }

  function closeDrawer() {
    var overlay = document.getElementById('aiteam-solution-create-overlay');
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    var drawer = document.getElementById('aiteam-solution-create-drawer');
    if (drawer && drawer.parentNode) drawer.parentNode.removeChild(drawer);
  }

  function openCreateDrawer(state, onSubmit) {
    closeDrawer();
    var overlay = document.createElement('div');
    overlay.className = 'aiteam-drawer__overlay';
    overlay.id = 'aiteam-solution-create-overlay';
    overlay.addEventListener('click', closeDrawer);

    var drawer = document.createElement('div');
    drawer.className = 'aiteam-drawer';
    drawer.id = 'aiteam-solution-create-drawer';
    drawer.innerHTML =
      '<div class="aiteam-drawer__header">' +
      '<h2 class="aiteam-drawer__title">创建行业方案</h2>' +
      '<button type="button" class="aiteam-drawer__close" data-aiteam-solution-create-close="1">×</button>' +
      '</div>' +
      '<div class="aiteam-drawer__section">' +
      '<label class="aiteam-drawer__field aiteam-drawer__field--block"><span class="aiteam-drawer__field-label">方案名称 *</span>' +
      '<input class="aiteam-input" type="text" data-aiteam-sol-name placeholder="例如：零售标准方案"></label>' +
      '<label class="aiteam-drawer__field aiteam-drawer__field--block"><span class="aiteam-drawer__field-label">方案描述</span>' +
      '<textarea class="aiteam-input" rows="3" data-aiteam-sol-desc placeholder="一句话描述这个行业方案"></textarea></label>' +
      '</div>' +
      '<div class="aiteam-drawer__section">' +
      '<h3 class="aiteam-drawer__section-title">配置专家</h3>' +
      '<div class="aiteam-drawer__scope-list" data-aiteam-sol-templates>' + renderTemplateCheckboxes(state.templates) + '</div>' +
      '</div>' +
      '<div class="aiteam-drawer__section">' +
      '<h3 class="aiteam-drawer__section-title">发布范围</h3>' +
      '<label class="aiteam-drawer__check"><input type="radio" name="aiteam-sol-scope" value="all" checked data-aiteam-scope-mode="all"> 全部企业可见</label>' +
      '<label class="aiteam-drawer__check"><input type="radio" name="aiteam-sol-scope" value="selected" data-aiteam-scope-mode="selected"> 仅指定企业可见</label>' +
      '<div class="aiteam-drawer__scope-list" data-aiteam-scope-enterprises hidden>' + renderEnterpriseCheckboxes(state.enterprises) + '</div>' +
      '</div>' +
      '<div class="aiteam-drawer__section">' +
      '<label class="aiteam-drawer__check"><input type="checkbox" data-aiteam-sol-publish> 创建后立即发布</label>' +
      '</div>' +
      '<div class="aiteam-drawer__section" data-aiteam-sol-error hidden></div>' +
      '<div class="aiteam-drawer__footer">' +
      '<button type="button" class="aiteam-btn" data-aiteam-solution-create-close="1">取消</button> ' +
      '<button type="button" class="aiteam-btn aiteam-btn--primary" data-aiteam-sol-submit>创建</button>' +
      '</div>';

    var host = document.getElementById('aiteam-app') || document.body;
    host.appendChild(overlay);
    host.appendChild(drawer);

    var scopeRadios = drawer.querySelectorAll('[data-aiteam-scope-mode]');
    var scopeBox = drawer.querySelector('[data-aiteam-scope-enterprises]');
    for (var i = 0; i < scopeRadios.length; i++) {
      scopeRadios[i].addEventListener('change', function () {
        var selected = drawer.querySelector('[data-aiteam-scope-mode="selected"]');
        if (scopeBox) scopeBox.hidden = !(selected && selected.checked);
      });
    }

    var closeButtons = drawer.querySelectorAll('[data-aiteam-solution-create-close]');
    for (var c = 0; c < closeButtons.length; c++) {
      closeButtons[c].addEventListener('click', closeDrawer);
    }

    function showError(msg) {
      var box = drawer.querySelector('[data-aiteam-sol-error]');
      if (!box) return;
      box.hidden = false;
      box.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>' + escapeHtml(msg) + '</p></div>';
    }

    var submitBtn = drawer.querySelector('[data-aiteam-sol-submit]');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        var name = trimText((drawer.querySelector('[data-aiteam-sol-name]') || {}).value);
        var desc = trimText((drawer.querySelector('[data-aiteam-sol-desc]') || {}).value);
        if (!name) { showError('请填写方案名称'); return; }
        var picks = drawer.querySelectorAll('[data-aiteam-tpl-pick]:checked');
        var templateIds = [];
        for (var p = 0; p < picks.length; p++) {
          templateIds.push(picks[p].getAttribute('data-aiteam-tpl-pick'));
        }
        var payload = { name: name, template_ids: templateIds };
        if (desc) payload.default_kb_blueprint = { description: desc };
        var selectedMode = drawer.querySelector('[data-aiteam-scope-mode="selected"]');
        if (selectedMode && selectedMode.checked) {
          var checks = drawer.querySelectorAll('[data-aiteam-scope-ent]:checked');
          var ids = [];
          for (var k = 0; k < checks.length; k++) {
            ids.push(checks[k].getAttribute('data-aiteam-scope-ent'));
          }
          if (!ids.length) { showError('请至少勾选一家企业，或选择「全部企业可见」'); return; }
          payload.publish_scope = { mode: 'selected', enterprise_ids: ids };
        } else {
          payload.publish_scope = { mode: 'all' };
        }
        var publishCheck = drawer.querySelector('[data-aiteam-sol-publish]');
        if (publishCheck && publishCheck.checked) payload.publish_action = 'publish';
        submitBtn.disabled = true;
        onSubmit(payload).then(function (result) {
          if (result && result.ok) {
            closeDrawer();
          } else {
            submitBtn.disabled = false;
            showError((result && result.error) || '创建失败，请重试');
          }
        });
      });
    }

    var nameInput = drawer.querySelector('[data-aiteam-sol-name]');
    if (nameInput && nameInput.focus) nameInput.focus();
  }

  // __DRAWER_PLACEHOLDER__

  function bindPanelInteractions(container, state) {
    var openBtn = container.querySelector ? container.querySelector('[data-aiteam-solution-create-open]') : null;
    if (openBtn && openBtn.addEventListener) {
      openBtn.addEventListener('click', function () {
        openCreateDrawer(state, container.lastCreateHandler);
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

    var previewButtons = container.querySelectorAll ? container.querySelectorAll('[data-aiteam-solution-preview]') : [];
    for (var j = 0; j < previewButtons.length; j++) {
      previewButtons[j].addEventListener('click', function (event) {
        var button = event && event.currentTarget ? event.currentTarget : this;
        var solutionId = button && button.getAttribute ? button.getAttribute('data-aiteam-solution-preview') : '';
        if (!solutionId) return;
        if (typeof container.lastPreviewHandler === 'function') {
          container.lastPreviewHandler(solutionId);
        }
      });
    }
  }

  ns.pages.systemSolutions = {
    init: function (container) {
      if (!container) return;

      container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载行业方案数据...</p></div>';

      var state = { items: [], notice: '', enterprises: [], templates: [] };

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

      container.lastPreviewHandler = function (solutionId) {
        state.previewSolutionId = solutionId;
        rerender('');
        return Promise.resolve({ ok: true, solution_id: solutionId });
      };

      // 拉取企业列表（发布范围）与专家模板列表（配置专家），失败不阻断主流程。
      ns.api.get('/api/system-admin/enterprises').then(function (result) {
        if (result && result.ok) {
          state.enterprises = normalizeItems(result.data && result.data.enterprises ? result.data.enterprises : result.data);
        }
      });
      ns.api.get('/api/system-admin/templates').then(function (result) {
        if (result && result.ok) {
          state.templates = normalizeItems(result.data);
        }
      });

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
        if (!state.previewSolutionId && state.items.length) {
          state.previewSolutionId = state.items[0].solution_id || state.items[0].id || '';
        }
        rerender('');
      });
    }
  };
}(window.aiteam));
