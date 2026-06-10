window.aiteam = window.aiteam || {};

(function registerSystemTemplatesPage(ns) {
  ns.pages = ns.pages || {};

  function trimText(value) {
    if (value === undefined || value === null) return '';
    return String(value).replace(/^\s+|\s+$/g, '');
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
      '<h3>' + (item.name || '') + '</h3>' +
      '<p>' + previewDescription + '</p>' +
      '</div>' +
      '<div class="aiteam-detail-kv">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">角色标识</span><span class="aiteam-shell__meta-value">' + (item.role_name || item.role || '—') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">默认模型</span><span class="aiteam-shell__meta-value">' + previewModel + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">标签</span><span class="aiteam-shell__meta-value">' + (tags.length ? tags.join(' / ') : '—') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">发布状态</span><span class="aiteam-shell__meta-value">' + (item.status || item.publish_state || 'draft') + '</span></div>' +
      '</div>' +
      '</div>';
  }

  function renderNotImplemented(container) {
    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
      '<h2 class="aiteam-shell__panel-title">专家管理</h2>' +
      '<p class="aiteam-shell__panel-body">模板治理 API 尚未实现（当前返回 501）。此区域已对接 `/api/system-admin/templates`，后端就绪后将承接模板列表、发布记录与上下架控制。</p>' +
      '<div class="aiteam-shell__meta">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">主读取接口</span><span class="aiteam-shell__meta-value">GET /api/system-admin/templates</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">后续写接口</span><span class="aiteam-shell__meta-value">POST /api/system-admin/templates · PATCH /api/system-admin/templates/{id}</span></div>' +
      '</div>' +
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
        '<td>' + templateId + '</td>' +
        '<td>' + (item.name || '') + '</td>' +
        '<td>' + (item.role_name || item.role || '') + '</td>' +
        '<td>' + status + '</td>' +
        '<td>' + (item.version_no || item.version || '-') + '</td>' +
        '<td>' + (typeof recruitCount === 'undefined' ? '-' : recruitCount) + '</td>' +
        '<td>' +
          '<button class="aiteam-btn aiteam-btn--sm" data-aiteam-action="update" data-aiteam-template-id="' + templateId + '">更新</button> ' +
          '<button class="aiteam-btn aiteam-btn--sm" data-aiteam-action="preview" data-aiteam-template-id="' + templateId + '">预览效果</button> ' +
          '<button class="aiteam-btn aiteam-btn--sm" data-aiteam-action="clone" data-aiteam-template-id="' + templateId + '">克隆</button> ' +
          '<button class="aiteam-btn aiteam-btn--sm" data-aiteam-action="' + publishAction + '" data-aiteam-template-id="' + templateId + '">' + publishLabel + '</button>' +
        '</td>' +
        '</tr>';
    }).join('');

    container.innerHTML =
      '<div class="aiteam-shell__panel">' +
      '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
      '<h2 class="aiteam-shell__panel-title">专家管理</h2>' +
      '<p class="aiteam-shell__panel-body">通过 `/api/system-admin/templates` 消费平台模板治理视图，并提供最小创建、更新和发布治理入口。</p>' +
      (notice ? '<div class="aiteam-state aiteam-state-empty"><p>' + notice + '</p></div>' : '') +
      '<form class="aiteam-shell__meta" data-aiteam-template-create-form="1">' +
      '<div class="aiteam-shell__meta-card"><label>模板名称<br><input class="aiteam-input" type="text" data-aiteam-template-create-name="1" placeholder="例如：销售专家"></label></div>' +
      '<div class="aiteam-shell__meta-card"><label>角色标识<br><input class="aiteam-input" type="text" data-aiteam-template-create-role="1" placeholder="例如：sales_advisor"></label></div>' +
      '<div class="aiteam-shell__meta-card"><label><input type="checkbox" data-aiteam-template-create-publish="1"> 创建后立即发布</label><br><button type="submit" class="aiteam-btn aiteam-btn--sm">新建模板</button></div>' +
      '</form>' +
      '<div class="aiteam-shell__meta">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">新建模板</span><span class="aiteam-shell__meta-value">输入名称 / 角色后提交</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">行级治理</span><span class="aiteam-shell__meta-value">更新、预览效果、克隆、发布记录都在这一页收口；发布 / 下架直接提交</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">发布记录</span><span class="aiteam-shell__meta-value">当前以前台招募数与版本号做最小展示；后续可继续扩成独立记录面板</span></div>' +
      '</div>' +
      '<div class="aiteam-panel aiteam-panel--nested">' + renderPreviewPanel(previewTemplate) + '</div>' +
      '<table class="aiteam-table"><thead><tr><th>ID</th><th>名称</th><th>角色</th><th>状态</th><th>版本</th><th>招募数</th><th>治理操作</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="7">暂无可治理的系统模板</td></tr>') +
      '</tbody></table>' +
      '</div>';
  }

  function bindPanelInteractions(container, state) {
    var createForm = container.querySelector ? container.querySelector('[data-aiteam-template-create-form]') : null;
    if (createForm && createForm.addEventListener) {
      createForm.addEventListener('submit', function (event) {
        if (event && event.preventDefault) event.preventDefault();
        var nameInput = container.querySelector ? container.querySelector('[data-aiteam-template-create-name]') : null;
        var roleInput = container.querySelector ? container.querySelector('[data-aiteam-template-create-role]') : null;
        var publishInput = container.querySelector ? container.querySelector('[data-aiteam-template-create-publish]') : null;
        var payload = {
          name: trimText(nameInput && nameInput.value),
          role_name: trimText(roleInput && roleInput.value)
        };
        if (publishInput && publishInput.checked) payload.publish_action = 'publish';
        if (!payload.name || !payload.role_name) return;
        container.lastCreateHandler(payload).then(function (result) {
          if (result && result.ok) {
            if (nameInput) nameInput.value = '';
            if (roleInput) roleInput.value = '';
            if (publishInput) publishInput.checked = false;
          }
        });
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
          var nextName = typeof window.prompt === 'function' ? window.prompt('请输入模板名称', current.name || '') : current.name;
          if (nextName === null) return;
          var nextRole = typeof window.prompt === 'function' ? window.prompt('请输入角色标识', current.role_name || current.role || '') : (current.role_name || current.role || '');
          if (nextRole === null) return;
          container.lastUpdateHandler(templateId, {
            name: trimText(nextName),
            role_name: trimText(nextRole)
          });
          return;
        }
        if (action === 'preview') {
          if (typeof container.lastPreviewHandler === 'function') {
            container.lastPreviewHandler(templateId);
          }
          return;
        }
        if (action === 'clone') {
          var current = findTemplate(state.items, templateId) || {};
          container.lastCreateHandler({
            name: trimText((current.name || '模板') + '（克隆）'),
            role_name: trimText(current.role_name || current.role || 'assistant'),
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

      var state = { items: [], notice: '' };

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
