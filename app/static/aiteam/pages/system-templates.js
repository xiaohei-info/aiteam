window.aiteam = window.aiteam || {};

(function registerSystemTemplatesPage(ns) {
  ns.pages = ns.pages || {};

  // Enterprise LLM model catalog — loaded once per page init, shared by the
  // create/edit drawer's 默认模型 dropdown. Mirrors admin-employees.
  function modelOptions(models, selectedValue) {
    var opts = ['<option value="">默认（继承企业默认模型）</option>'];
    var list = Array.isArray(models) ? models : [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i] || {};
      var value = (m.provider_key || '') + '|' + (m.model_id || '');
      var label = (m.provider_name || m.provider_key || '') + ' · ' + (m.label || m.model_id || '');
      var sel = value === selectedValue ? ' selected' : '';
      opts.push('<option value="' + escapeHtml(value) + '"' + sel + '>' + escapeHtml(label) + '</option>');
    }
    return opts.join('');
  }

  // A search box + scrollable checkbox list, scoped by a unique `key` so several
  // pickers can coexist in one drawer. `rowsHtml` is the joined <label> rows the
  // caller already built (each carries its own id data-attr). Filtering is pure
  // DOM (toggle label.hidden by text) — no re-render, no state.
  function renderPicker(key, rowsHtml, opts) {
    var o = opts || {};
    if (!rowsHtml) {
      return '<p class="aiteam-drawer__desc">' + escapeHtml(o.empty || '暂无可选项') + '</p>';
    }
    return '<div class="aiteam-picker" data-picker="' + escapeHtml(key) + '">' +
      '<input class="aiteam-input aiteam-picker__search" type="text" data-picker-search' +
      ' placeholder="' + escapeHtml(o.placeholder || '输入关键词筛选…') + '">' +
      '<div class="aiteam-picker__list">' + rowsHtml + '</div>' +
      '</div>';
  }

  // Wire a picker's search box to filter its <label> rows by text.
  function bindPicker(scope, key) {
    if (!scope || !scope.querySelector) return;
    var box = scope.querySelector('[data-picker="' + key + '"]');
    if (!box || !box.querySelector) return;
    var search = box.querySelector('[data-picker-search]');
    if (!search || !search.addEventListener) return;
    search.addEventListener('input', function () {
      var q = trimText(search.value).toLowerCase();
      var labels = box.querySelectorAll('.aiteam-drawer__check');
      for (var i = 0; i < labels.length; i++) {
        var text = (labels[i].textContent || '').toLowerCase();
        labels[i].hidden = !!(q && text.indexOf(q) === -1);
      }
    });
  }

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
    if (payload && Array.isArray(payload.templates)) return payload.templates.slice();
    return [];
  }

  function mergeTemplateRecord(current, incoming) {
    return Object.assign({}, current || {}, incoming || {});
  }

  function findTemplate(items, templateId) {
    var list = Array.isArray(items) ? items : [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      if ((item.template_id || item.id) === templateId) return item;
    }
    return null;
  }

  function upsertTemplate(items, templateId, patch) {
    var list = Array.isArray(items) ? items.slice() : [];
    var merged = false;
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      var currentId = item.template_id || item.id;
      if (currentId === templateId) {
        list[i] = mergeTemplateRecord(item, patch);
        merged = true;
        break;
      }
    }
    if (!merged) {
      list.unshift(mergeTemplateRecord({ template_id: templateId }, patch));
    }
    return list;
  }

  function scopeLabel(item) {
    var scope = item && item.publish_scope;
    if (!scope || scope.mode !== 'selected') return '全部可见';
    var ids = Array.isArray(scope.enterprise_ids) ? scope.enterprise_ids : [];
    return '指定企业 (' + ids.length + ')';
  }

  function renderPreviewPanel(item) {
    if (!item) {
      return '<div class="aiteam-inline-empty">选择一个模板后查看用户端预览。</div>';
    }
    var tags = Array.isArray(item.tags) ? item.tags : [];
    var previewModel = item.default_model || ((item.default_model_ref || {}).model) || '—';
    var previewDescription = item.description || ((item.prompt_pack || {}).description) || '暂无岗位描述';
    return '' +
      '<div class="aiteam-detail-section">' +
      '<h3>用户端预览</h3>' +
      '<div class="aiteam-chat-summary__hero">' +
      '<h3>' + escapeHtml(item.name || '') + '</h3>' +
      '<p>' + escapeHtml(previewDescription) + '</p>' +
      '</div>' +
      '<div class="aiteam-detail-kv">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">角色标识</span><span class="aiteam-shell__meta-value">' + escapeHtml(item.role_name || item.role || '—') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">默认模型</span><span class="aiteam-shell__meta-value">' + escapeHtml(previewModel) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">标签</span><span class="aiteam-shell__meta-value">' + escapeHtml(tags.length ? tags.join(' / ') : '—') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">发布状态</span><span class="aiteam-shell__meta-value">' + escapeHtml(item.status || item.publish_state || 'draft') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">发布范围</span><span class="aiteam-shell__meta-value">' + escapeHtml(scopeLabel(item)) + '</span></div>' +
      '</div>' +
      '</div>';
  }

  function renderNotImplemented(container) {
    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
      '<h2 class="aiteam-shell__panel-title">专家管理</h2>' +
      '<p class="aiteam-shell__panel-body">专家模板数据暂时不可用，请稍后刷新重试。</p>' +
      '</div>';
  }

  function renderPanel(container, state) {
    var items = normalizeItems(state && state.items);
    var notice = state && state.notice ? state.notice : '';
    var previewTemplate = findTemplate(items, state && state.previewTemplateId);
    var rows = items.map(function (item) {
      var templateId = item.template_id || item.id || '';
      var status = item.status || item.publish_state || '';
      var publishLabel = status === 'published' ? '下架' : '发布';
      var publishAction = status === 'published' ? 'unpublish' : 'publish';
      var recruitCount = item.recruit_count;
      if (typeof recruitCount === 'undefined' && item.publish_record && typeof item.publish_record.recruit_count !== 'undefined') {
        recruitCount = item.publish_record.recruit_count;
      }
      return '<tr>' +
        '<td>' + escapeHtml(templateId) + '</td>' +
        '<td>' + escapeHtml(item.name || '') + '</td>' +
        '<td>' + escapeHtml(item.role_name || item.role || '') + '</td>' +
        '<td>' + escapeHtml(status) + '</td>' +
        '<td>' + escapeHtml(scopeLabel(item)) + '</td>' +
        '<td>' + escapeHtml(item.version_no || item.version || '-') + '</td>' +
        '<td>' + (typeof recruitCount === 'undefined' ? '-' : escapeHtml(recruitCount)) + '</td>' +
        '<td>' +
          '<button class="aiteam-btn aiteam-btn--sm" data-aiteam-action="update" data-aiteam-template-id="' + escapeHtml(templateId) + '">更新</button> ' +
          '<button class="aiteam-btn aiteam-btn--sm" data-aiteam-action="preview" data-aiteam-template-id="' + escapeHtml(templateId) + '">预览效果</button> ' +
          '<button class="aiteam-btn aiteam-btn--sm" data-aiteam-action="clone" data-aiteam-template-id="' + escapeHtml(templateId) + '">克隆</button> ' +
          '<button class="aiteam-btn aiteam-btn--sm" data-aiteam-action="' + publishAction + '" data-aiteam-template-id="' + escapeHtml(templateId) + '">' + publishLabel + '</button>' +
        '</td>' +
        '</tr>';
    }).join('');

    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
      '<h2 class="aiteam-shell__panel-title">专家管理</h2>' +
      '<p class="aiteam-shell__panel-body">管理人才市场中的专家模板：创建、更新、预览、克隆，以及发布与下架。可控制每个专家发布给哪些企业。</p>' +
      (notice ? '<div class="aiteam-state aiteam-state-empty"><p>' + escapeHtml(notice) + '</p></div>' : '') +
      '<div class="aiteam-shell__toolbar"><button type="button" class="aiteam-btn aiteam-btn--primary" data-aiteam-template-create-open="1">➕ 创建专家</button></div>' +
      '<div class="aiteam-panel aiteam-panel--nested">' + renderPreviewPanel(previewTemplate) + '</div>' +
      '<table class="aiteam-table"><thead><tr><th>ID</th><th>名称</th><th>角色</th><th>状态</th><th>发布范围</th><th>版本</th><th>招募数</th><th>治理操作</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="8">暂无可治理的系统模板</td></tr>') +
      '</tbody></table>' +
      '</div>';
  }

  function enterpriseRows(enterprises, selectedIds) {
    var list = Array.isArray(enterprises) ? enterprises : [];
    var picked = {};
    (selectedIds || []).forEach(function (id) { picked[id] = true; });
    return list.map(function (ent) {
      var id = ent.enterprise_id || ent.id || '';
      var name = ent.name || id;
      var checked = picked[id] ? ' checked' : '';
      return '<label class="aiteam-drawer__check"><input type="checkbox" data-aiteam-scope-ent="' + escapeHtml(id) + '"' + checked + '> ' + escapeHtml(name) + ' <span class="aiteam-drawer__binding-meta">' + escapeHtml(id) + '</span></label>';
    }).join('');
  }

  function closeDrawer() {
    var overlay = document.getElementById('aiteam-template-create-overlay');
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    var drawer = document.getElementById('aiteam-template-create-drawer');
    if (drawer && drawer.parentNode) drawer.parentNode.removeChild(drawer);
  }

  function reopenTemplateDrawer(container, state) {
    var active = container && container.__activeTemplateDrawer;
    if (!active || typeof active.onSubmit !== 'function') return;
    openCreateDrawer(state, active.onSubmit, active.editTemplate || null);
  }

  function openCreateDrawer(state, onSubmit, editTemplate) {
    closeDrawer();
    var edit = editTemplate || null;
    var promptPack = (edit && edit.prompt_pack) || {};
    var modelRef = (edit && edit.default_model_ref) || {};
    var scope = (edit && edit.publish_scope) || {};
    var selectedEntIds = scope.mode === 'selected' && Array.isArray(scope.enterprise_ids) ? scope.enterprise_ids : [];
    var selectedModel = modelRef.provider || modelRef.model ? (modelRef.provider || '') + '|' + (modelRef.model || '') : '';

    var overlay = document.createElement('div');
    overlay.className = 'aiteam-drawer__overlay';
    overlay.id = 'aiteam-template-create-overlay';
    overlay.addEventListener('click', closeDrawer);

    var drawer = document.createElement('div');
    drawer.className = 'aiteam-drawer';
    drawer.id = 'aiteam-template-create-drawer';
    drawer.innerHTML =
      '<div class="aiteam-drawer__header">' +
      '<h2 class="aiteam-drawer__title">' + (edit ? '编辑专家' : '创建专家') + '</h2>' +
      '<button type="button" class="aiteam-drawer__close" data-aiteam-template-create-close="1">×</button>' +
      '</div>' +
      '<div class="aiteam-drawer__section">' +
      '<label class="aiteam-drawer__field aiteam-drawer__field--block"><span class="aiteam-drawer__field-label">模板名称 *</span>' +
      '<input class="aiteam-input" type="text" data-aiteam-tpl-name placeholder="例如：销售专家" value="' + escapeHtml(edit ? (edit.name || '') : '') + '"></label>' +
      '<label class="aiteam-drawer__field aiteam-drawer__field--block"><span class="aiteam-drawer__field-label">角色标识 *</span>' +
      '<input class="aiteam-input" type="text" data-aiteam-tpl-role placeholder="例如：sales_advisor" value="' + escapeHtml(edit ? (edit.role_name || edit.role || '') : '') + '"></label>' +
      '<label class="aiteam-drawer__field aiteam-drawer__field--block"><span class="aiteam-drawer__field-label">分类</span>' +
      '<input class="aiteam-input" type="text" data-aiteam-tpl-category placeholder="例如：sales" value="' + escapeHtml(edit ? (edit.category_code || edit.category || '') : '') + '"></label>' +
      '<label class="aiteam-drawer__field aiteam-drawer__field--block"><span class="aiteam-drawer__field-label">岗位描述</span>' +
      '<textarea class="aiteam-input" rows="3" data-aiteam-tpl-desc placeholder="一句话描述这个专家擅长什么">' + escapeHtml(promptPack.description || '') + '</textarea></label>' +
      '<label class="aiteam-drawer__field aiteam-drawer__field--block"><span class="aiteam-drawer__field-label">默认模型</span>' +
      '<select class="aiteam-select" data-aiteam-tpl-model>' + modelOptions(state.models, selectedModel) + '</select></label>' +
      '<label class="aiteam-drawer__field aiteam-drawer__field--block"><span class="aiteam-drawer__field-label">系统提示词</span>' +
      '<textarea class="aiteam-input" rows="4" data-aiteam-tpl-prompt placeholder="专家的系统人设提示词，留空则使用默认">' + escapeHtml(promptPack.system_prompt || '') + '</textarea></label>' +
      '</div>' +
      '<div class="aiteam-drawer__section">' +
      '<h3 class="aiteam-drawer__section-title">发布范围</h3>' +
      '<label class="aiteam-drawer__check"><input type="radio" name="aiteam-tpl-scope" value="all"' + (selectedEntIds.length ? '' : ' checked') + ' data-aiteam-scope-mode="all"> 全部企业可见</label>' +
      '<label class="aiteam-drawer__check"><input type="radio" name="aiteam-tpl-scope" value="selected"' + (selectedEntIds.length ? ' checked' : '') + ' data-aiteam-scope-mode="selected"> 仅指定企业可见</label>' +
      '<div class="aiteam-drawer__scope-list" data-aiteam-scope-enterprises' + (selectedEntIds.length ? '' : ' hidden') + '>' +
      renderPicker('tpl-ent', enterpriseRows(state.enterprises, selectedEntIds), { placeholder: '搜索企业名称…', empty: '暂无企业可选（创建后可在更新中调整）。' }) +
      '</div>' +
      '</div>' +
      (edit ? '' :
        '<div class="aiteam-drawer__section">' +
        '<label class="aiteam-drawer__check"><input type="checkbox" data-aiteam-tpl-publish> 创建后立即发布</label>' +
        '</div>') +
      '<div class="aiteam-drawer__section" data-aiteam-tpl-error hidden></div>' +
      '<div class="aiteam-drawer__footer">' +
      '<button type="button" class="aiteam-btn" data-aiteam-template-create-close="1">取消</button> ' +
      '<button type="button" class="aiteam-btn aiteam-btn--primary" data-aiteam-tpl-submit>' + (edit ? '保存' : '创建') + '</button>' +
      '</div>';

    var host = document.getElementById('aiteam-app') || document.body;
    host.appendChild(overlay);
    host.appendChild(drawer);

    bindPicker(drawer, 'tpl-ent');

    var scopeRadios = drawer.querySelectorAll('[data-aiteam-scope-mode]');
    var scopeBox = drawer.querySelector('[data-aiteam-scope-enterprises]');
    for (var i = 0; i < scopeRadios.length; i++) {
      scopeRadios[i].addEventListener('change', function () {
        var selected = drawer.querySelector('[data-aiteam-scope-mode="selected"]');
        if (scopeBox) scopeBox.hidden = !(selected && selected.checked);
      });
    }

    var closeButtons = drawer.querySelectorAll('[data-aiteam-template-create-close]');
    for (var c = 0; c < closeButtons.length; c++) {
      closeButtons[c].addEventListener('click', closeDrawer);
    }

    function showError(msg) {
      var box = drawer.querySelector('[data-aiteam-tpl-error]');
      if (!box) return;
      box.hidden = false;
      box.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>' + escapeHtml(msg) + '</p></div>';
    }

    var submitBtn = drawer.querySelector('[data-aiteam-tpl-submit]');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        var name = trimText((drawer.querySelector('[data-aiteam-tpl-name]') || {}).value);
        var role = trimText((drawer.querySelector('[data-aiteam-tpl-role]') || {}).value);
        var category = trimText((drawer.querySelector('[data-aiteam-tpl-category]') || {}).value);
        var desc = trimText((drawer.querySelector('[data-aiteam-tpl-desc]') || {}).value);
        var systemPrompt = trimText((drawer.querySelector('[data-aiteam-tpl-prompt]') || {}).value);
        var modelValue = trimText((drawer.querySelector('[data-aiteam-tpl-model]') || {}).value);
        if (!name) { showError('请填写模板名称'); return; }
        if (!role) { showError('请填写角色标识'); return; }
        var payload = { name: name, role_name: role, category_code: category };
        payload.prompt_pack = { description: desc, system_prompt: systemPrompt };
        if (modelValue) {
          var parts = modelValue.split('|');
          payload.default_model_ref = { provider: parts[0] || '', model: parts[1] || '' };
        } else {
          payload.default_model_ref = {};
        }
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
        var publishCheck = drawer.querySelector('[data-aiteam-tpl-publish]');
        if (publishCheck && publishCheck.checked) payload.publish_action = 'publish';
        submitBtn.disabled = true;
        onSubmit(payload).then(function (result) {
          if (result && result.ok) {
            closeDrawer();
          } else {
            submitBtn.disabled = false;
            showError((result && result.error) || (edit ? '保存失败，请重试' : '创建失败，请重试'));
          }
        });
      });
    }

    var nameInput = drawer.querySelector('[data-aiteam-tpl-name]');
    if (nameInput && nameInput.focus) nameInput.focus();
  }

  function bindPanelInteractions(container, state) {
    var openBtn = container.querySelector ? container.querySelector('[data-aiteam-template-create-open]') : null;
    if (openBtn && openBtn.addEventListener) {
      openBtn.addEventListener('click', function () {
        container.__activeTemplateDrawer = { onSubmit: container.lastCreateHandler, editTemplate: null };
        openCreateDrawer(state, container.lastCreateHandler);
      });
    }

    var buttons = container.querySelectorAll ? container.querySelectorAll('button[data-aiteam-action][data-aiteam-template-id]') : [];
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function (event) {
        var button = event && event.currentTarget ? event.currentTarget : this;
        var templateId = button && button.getAttribute ? button.getAttribute('data-aiteam-template-id') : '';
        var action = button && button.getAttribute ? button.getAttribute('data-aiteam-action') : '';
        if (!templateId || !action) return;
        if (action === 'update') {
          var current = findTemplate(state.items, templateId) || {};
          container.__activeTemplateDrawer = {
            onSubmit: function (payload) {
              return container.lastUpdateHandler(templateId, payload);
            },
            editTemplate: current,
          };
          openCreateDrawer(state, function (payload) {
            return container.lastUpdateHandler(templateId, payload);
          }, current);
          return;
        }
        if (action === 'preview') {
          if (typeof container.lastPreviewHandler === 'function') {
            container.lastPreviewHandler(templateId);
          }
          return;
        }
        if (action === 'clone') {
          var src = findTemplate(state.items, templateId) || {};
          container.lastCreateHandler({
            name: trimText((src.name || '模板') + '（克隆）'),
            role_name: trimText(src.role_name || src.role || 'assistant')
          });
          return;
        }
        container.lastPublishHandler(templateId, action);
      });
    }
  }

  ns.pages.systemTemplates = {
    init: function (container) {
      if (!container) return;

      container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载模板治理数据...</p></div>';

      var state = { items: [], notice: '', enterprises: [], models: [] };

      function rerender(notice) {
        state.notice = notice || '';
        renderPanel(container, state);
        bindPanelInteractions(container, state);
      }

      container.lastCreateHandler = function (payload) {
        var request = payload || {};
        return ns.api.post('/api/system-admin/templates', request).then(function (result) {
          if (result && result.ok) {
            var created = mergeTemplateRecord(request, result.data || {});
            var templateId = created.template_id || created.id || request.template_id || request.id || ('draft-' + (state.items.length + 1));
            state.items = upsertTemplate(state.items, templateId, created);
            rerender('系统模板已创建');
            return result;
          }
          rerender('系统模板创建失败');
          return result;
        });
      };

      container.lastUpdateHandler = function (templateId, payload) {
        var request = payload || {};
        return ns.api.patch('/api/system-admin/templates/' + encodeURIComponent(templateId), request).then(function (result) {
          if (result && result.ok) {
            state.items = upsertTemplate(state.items, templateId, mergeTemplateRecord(request, result.data || {}));
            rerender('系统模板已提交更新');
            return result;
          }
          rerender('系统模板更新失败');
          return result;
        });
      };

      container.lastPublishHandler = function (templateId, publishAction) {
        var action = trimText(publishAction) || 'publish';
        return ns.api.patch('/api/system-admin/templates/' + encodeURIComponent(templateId), { publish_action: action }).then(function (result) {
          if (result && result.ok) {
            state.items = upsertTemplate(state.items, templateId, mergeTemplateRecord(result.data || {}, {
              status: action === 'publish' ? 'published' : 'draft',
              publish_state: action === 'publish' ? 'published' : 'draft'
            }));
            rerender(action === 'publish' ? '系统模板已发布' : '系统模板已下架');
            return result;
          }
          rerender(action === 'publish' ? '系统模板发布失败' : '系统模板下架失败');
          return result;
        });
      };

      container.lastPreviewHandler = function (templateId) {
        state.previewTemplateId = templateId;
        rerender('');
        return Promise.resolve({ ok: true, template_id: templateId });
      };

      // 拉取企业列表供「发布范围-指定企业」勾选（失败不阻断主流程）。
      ns.api.get('/api/system-admin/enterprises').then(function (result) {
        if (result && result.ok) {
          state.enterprises = normalizeItems(result.data && result.data.enterprises ? result.data.enterprises : result.data);
          reopenTemplateDrawer(container, state);
        }
      });

      // 拉取企业模型目录供创建/编辑专家时选择默认模型（失败不阻断主流程）。
      if (ns.api && ns.api.getLlmModels) {
        ns.api.getLlmModels().then(function (result) {
          if (result && result.ok && result.data) {
            state.models = result.data.models || [];
          }
        });
      }

      ns.api.get('/api/system-admin/templates').then(function (result) {
        if (!result.ok) {
          if (result.status === 501) {
            renderNotImplemented(container);
            return;
          }
          if (ns.states && ns.states.handleApiResult) {
            ns.states.handleApiResult(result, container, function () {});
          } else {
            container.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>⚠ 模板治理数据加载失败</p></div>';
          }
          return;
        }
        state.items = normalizeItems(result.data);
        if (!state.previewTemplateId && state.items.length) {
          state.previewTemplateId = state.items[0].template_id || state.items[0].id || '';
        }
        rerender('');
      });
    }
  };
}(window.aiteam));
