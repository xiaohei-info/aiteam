// admin-memories.js — Team Panel memory management page
window.aiteam = window.aiteam || {};

(function registerAdminMemoriesPage(ns) {
  ns.pages = ns.pages || {};

  function escapeHtml(value) {
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

  function normalizeAuditEvents(item) {
    var raw = [];
    if (Array.isArray(item && item.audit_trace)) raw = item.audit_trace;
    else if (Array.isArray(item && item.audit_events)) raw = item.audit_events;
    return raw.map(function (entry) {
      return {
        action: stringValue(entry && (entry.action || entry.event_type), 'unknown'),
        actor: stringValue(entry && (entry.actor_name || entry.actor_id), 'system'),
        timestamp: stringValue(entry && (entry.timestamp || entry.created_at), ''),
      };
    });
  }

  function normalizePromptRefs(item) {
    var raw = [];
    if (Array.isArray(item && item.prompt_plan_refs)) raw = item.prompt_plan_refs;
    else if (Array.isArray(item && item.prompt_refs)) raw = item.prompt_refs;
    return raw.map(function (entry) {
      if (typeof entry === 'string') return entry.trim();
      return stringValue(entry && (entry.run_id || entry.plan_id || entry.reference_id), '').trim();
    }).filter(Boolean);
  }

  function normalizeMemoryItem(item) {
    return {
      memory_id: stringValue(item && item.memory_id, ''),
      employee_id: stringValue(item && item.employee_id, ''),
      employee_name: stringValue(item && (item.employee_name || item.display_name), '未分配员工'),
      content: stringValue(item && item.content, ''),
      importance: Number(item && item.importance) || 1,
      category: stringValue(item && item.category, 'uncategorized'),
      tags: Array.isArray(item && item.tags) ? item.tags.slice() : [],
      source: stringValue(item && (item.source || item.source_type), 'manual'),
      created_at: stringValue(item && item.created_at, ''),
      updated_at: stringValue(item && item.updated_at, stringValue(item && item.created_at, '')),
      last_used_at: stringValue(item && item.last_used_at, ''),
      visibility_scope: stringValue(item && item.visibility_scope, ''),
      review_status: stringValue(item && (item.review_status || item.decision_status), ''),
      extraction_status: stringValue(item && (item.extraction_status || item.writeback_status), ''),
      extraction_error_message: stringValue(item && (item.extraction_error_message || item.failure_message), ''),
      audit_events: normalizeAuditEvents(item),
      prompt_plan_refs: normalizePromptRefs(item),
    };
  }

  function sortMemories(items) {
    return items.slice().sort(function (left, right) {
      if (right.importance !== left.importance) return right.importance - left.importance;
      return stringValue(right.updated_at).localeCompare(stringValue(left.updated_at));
    });
  }

  function normalizePayload(data) {
    var rawItems = [];
    if (Array.isArray(data)) rawItems = data;
    else if (data && Array.isArray(data.memories)) rawItems = data.memories;
    else if (data && Array.isArray(data.items)) rawItems = data.items;
    return sortMemories(rawItems.map(normalizeMemoryItem));
  }

  function createStore(items) {
    var list = sortMemories((items || []).map(normalizeMemoryItem));

    function setAll(nextItems) {
      list = sortMemories((nextItems || []).map(normalizeMemoryItem));
      return list.slice();
    }

    return {
      all: function () {
        return list.slice();
      },
      replace: function (nextItems) {
        return setAll(nextItems);
      },
      upsert: function (item) {
        var normalized = normalizeMemoryItem(item);
        var next = list.filter(function (entry) {
          return entry.memory_id !== normalized.memory_id;
        });
        next.push(normalized);
        return setAll(next);
      },
      remove: function (memoryId) {
        return setAll(list.filter(function (entry) {
          return entry.memory_id !== memoryId;
        }));
      },
      filter: function (criteria) {
        criteria = criteria || {};
        var employeeId = stringValue(criteria.employeeId, '');
        var query = stringValue(criteria.query, '').toLowerCase();
        var category = stringValue(criteria.category, 'all');
        return list.filter(function (entry) {
          if (employeeId && entry.employee_id !== employeeId) return false;
          if (category && category !== 'all' && entry.category !== category) return false;
          if (!query) return true;
          var haystack = [entry.content, entry.employee_name, entry.category, entry.extraction_status, entry.review_status]
            .concat(entry.tags || [])
            .concat(entry.prompt_plan_refs || [])
            .join(' ')
            .toLowerCase();
          return haystack.indexOf(query) !== -1;
        });
      }
    };
  }

  function collectEmployees(items) {
    var map = {};
    (items || []).forEach(function (entry) {
      if (!entry.employee_id || map[entry.employee_id]) return;
      map[entry.employee_id] = {
        employee_id: entry.employee_id,
        employee_name: entry.employee_name || '未命名员工'
      };
    });
    return Object.keys(map).sort().map(function (key) {
      return map[key];
    });
  }

  function collectCategories(items) {
    var map = { all: '全部分类' };
    (items || []).forEach(function (entry) {
      if (!entry.category) return;
      map[entry.category] = entry.category;
    });
    return Object.keys(map).map(function (key) {
      return { value: key, label: map[key] };
    });
  }

  function renderStars(importance) {
    var count = Math.max(1, Math.min(5, Number(importance) || 1));
    return '★'.repeat(count) + '☆'.repeat(5 - count);
  }

  function apiErrorMessage(result) {
    if (result && result.status === 403) return '您没有权限访问记忆管理';
    if (result && result.status === 404) return '记忆 API 尚未实现（当前返回 404）。';
    if (result && result.status === 501) return '记忆 API 尚未实现（当前返回 501）。';
    if (result && result.error) return result.error;
    if (result && typeof result.status !== 'undefined') return '请求失败 (' + result.status + ')';
    return '网络请求失败';
  }

  function createPageController(container) {
    var store = createStore([]);
    var state = {
      employeeId: '',
      query: '',
      category: 'all',
      bannerMessages: []
    };

    function filteredItems() {
      return store.filter(state);
    }

    function buildBannerMessages() {
      var messages = state.bannerMessages.slice();
      var allItems = store.all();
      var failedExtractions = allItems.filter(function (entry) {
        return entry.extraction_status && entry.extraction_status.toLowerCase().indexOf('fail') !== -1;
      }).length;
      var missingAudit = allItems.filter(function (entry) {
        return !(entry.audit_events && entry.audit_events.length);
      }).length;
      if (failedExtractions) {
        messages.push('检测到 ' + failedExtractions + ' 条自动提取失败/写回异常记忆，前端继续允许人工 CRUD，不阻断治理流程。');
      }
      if (missingAudit && allItems.length) {
        messages.push('有 ' + missingAudit + ' 条记忆未返回审计追踪字段；页面已显式展示降级而不伪造日志。');
      }
      if (!allItems.length) {
        messages.push('该员工尚未形成记忆，可手动添加或通过对话沉淀。');
      }
      return messages;
    }

    function renderToolbar(items) {
      var employees = collectEmployees(store.all());
      var categories = collectCategories(store.all());
      return '<div class="aiteam-memory__toolbar">' +
        '<div class="aiteam-memory__toolbar-row">' +
        '<label class="aiteam-memory__field"><span>员工</span><select data-role="employee-filter">' +
        '<option value="">全部员工</option>' +
        employees.map(function (item) {
          var selected = item.employee_id === state.employeeId ? ' selected' : '';
          return '<option value="' + escapeHtml(item.employee_id) + '"' + selected + '>' + escapeHtml(item.employee_name) + '</option>';
        }).join('') +
        '</select></label>' +
        '<label class="aiteam-memory__field aiteam-memory__field--grow"><span>搜索</span><input data-role="query-filter" type="search" value="' + escapeHtml(state.query) + '" placeholder="按内容、标签、Prompt Plan 引用搜索"></label>' +
        '<button type="button" class="aiteam-memory__primary" data-role="add-memory">+ 新增记忆</button>' +
        '</div>' +
        '<div class="aiteam-memory__categories">' +
        categories.map(function (item) {
          var active = item.value === state.category ? ' is-active' : '';
          return '<button type="button" class="aiteam-memory__chip' + active + '" data-role="category-filter" data-category="' + escapeHtml(item.value) + '">' + escapeHtml(item.label) + '</button>';
        }).join('') +
        '</div>' +
        '<p class="aiteam-memory__summary">当前显示 ' + items.length + ' / ' + store.all().length + ' 条记忆</p>' +
        '</div>';
    }

    function renderAuditTrace(item) {
      if (!item.audit_events.length) {
        return '<p class="aiteam-memory__audit-note">审计追踪未返回，页面展示降级提示并保留人工核查入口。</p>';
      }
      return '<ul class="aiteam-memory__audit-list">' + item.audit_events.map(function (entry) {
        return '<li><span>' + escapeHtml(entry.action) + '</span><span>' + escapeHtml(entry.actor) + '</span><span>' + escapeHtml(entry.timestamp || '未知时间') + '</span></li>';
      }).join('') + '</ul>';
    }

    function renderPromptRefs(item) {
      if (!item.prompt_plan_refs.length) {
        return '<p class="aiteam-memory__audit-note">当前后端未返回 Prompt Plan 引用。</p>';
      }
      return '<div class="aiteam-memory__tags">' + item.prompt_plan_refs.map(function (ref) {
        return '<span class="aiteam-memory__tag">' + escapeHtml(ref) + '</span>';
      }).join('') + '</div>';
    }

    function renderCards(items) {
      if (!items.length) {
        return '<div class="aiteam-memory__empty"><p>当前筛选条件下暂无记忆条目。</p></div>';
      }
      return '<div class="aiteam-memory__cards">' + items.map(function (item) {
        var extractionWarning = '';
        if (item.extraction_status && item.extraction_status.toLowerCase().indexOf('fail') !== -1) {
          extractionWarning = '<div class="aiteam-memory__warning">自动提取/写回失败：' + escapeHtml(item.extraction_error_message || item.extraction_status) + '</div>';
        } else if (item.extraction_status) {
          extractionWarning = '<div class="aiteam-memory__audit-note">自动提取状态：' + escapeHtml(item.extraction_status) + '</div>';
        }
        var reviewLine = item.review_status ? '<span>审核：' + escapeHtml(item.review_status) + '</span>' : '';
        var visibilityLine = item.visibility_scope ? '<span>可见范围：' + escapeHtml(item.visibility_scope) + '</span>' : '<span>可见范围：按员工授权过滤</span>';
        return '<article class="aiteam-memory__card" data-memory-id="' + escapeHtml(item.memory_id) + '">' +
          '<div class="aiteam-memory__card-head">' +
          '<div><h3>' + escapeHtml(item.employee_name) + '</h3><p>' + escapeHtml(item.employee_id) + '</p></div>' +
          '<span class="aiteam-memory__importance">' + escapeHtml(renderStars(item.importance)) + '</span>' +
          '</div>' +
          '<p class="aiteam-memory__content">' + escapeHtml(item.content) + '</p>' +
          extractionWarning +
          '<div class="aiteam-memory__meta">' +
          '<span>' + escapeHtml(item.category) + '</span>' +
          '<span>' + escapeHtml(item.source) + '</span>' +
          visibilityLine +
          reviewLine +
          '<span>' + escapeHtml(item.updated_at || item.created_at || '未知时间') + '</span>' +
          '</div>' +
          '<div class="aiteam-memory__tags">' + (item.tags || []).map(function (tag) {
            return '<span class="aiteam-memory__tag">' + escapeHtml(tag) + '</span>';
          }).join('') + '</div>' +
          '<div class="aiteam-memory__subsection"><strong>Prompt Plan 引用</strong>' + renderPromptRefs(item) + '</div>' +
          '<div class="aiteam-memory__subsection"><strong>审计追踪</strong>' + renderAuditTrace(item) + '</div>' +
          '<div class="aiteam-memory__actions">' +
          '<button type="button" data-role="edit-memory" data-memory-id="' + escapeHtml(item.memory_id) + '">编辑</button>' +
          '<button type="button" data-role="delete-memory" data-memory-id="' + escapeHtml(item.memory_id) + '">删除</button>' +
          '</div>' +
          '</article>';
      }).join('') + '</div>';
    }

    function bindEvents() {
      if (!container || !container.querySelector) return;
      var employeeSelect = container.querySelector('[data-role="employee-filter"]');
      var queryInput = container.querySelector('[data-role="query-filter"]');
      var addButton = container.querySelector('[data-role="add-memory"]');
      var categoryButtons = container.querySelectorAll ? container.querySelectorAll('[data-role="category-filter"]') : [];
      var editButtons = container.querySelectorAll ? container.querySelectorAll('[data-role="edit-memory"]') : [];
      var deleteButtons = container.querySelectorAll ? container.querySelectorAll('[data-role="delete-memory"]') : [];

      if (employeeSelect) {
        employeeSelect.addEventListener('change', function () {
          state.employeeId = this.value || '';
          render();
        });
      }
      if (queryInput) {
        queryInput.addEventListener('input', function () {
          state.query = this.value || '';
          render();
        });
      }
      if (addButton) {
        addButton.addEventListener('click', function () {
          createMemory();
        });
      }
      for (var i = 0; i < categoryButtons.length; i++) {
        categoryButtons[i].addEventListener('click', function () {
          state.category = this.getAttribute('data-category') || 'all';
          render();
        });
      }
      for (var j = 0; j < editButtons.length; j++) {
        editButtons[j].addEventListener('click', function () {
          updateMemory(this.getAttribute('data-memory-id'));
        });
      }
      for (var k = 0; k < deleteButtons.length; k++) {
        deleteButtons[k].addEventListener('click', function () {
          deleteMemory(this.getAttribute('data-memory-id'));
        });
      }
    }

    function render() {
      var items = filteredItems();
      var bannerMessages = buildBannerMessages();
      container.innerHTML =
        '<div class="aiteam-shell__panel aiteam-memory">' +
        '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
        '<h2 class="aiteam-shell__panel-title">记忆管理</h2>' +
        '<p class="aiteam-shell__panel-body">通过 /api/team/memories 管理员工记忆条目，支持搜索、分类筛选、基础 CRUD，以及自动提取失败/审计追踪的可见降级。</p>' +
        '<div class="aiteam-memory__banners">' + bannerMessages.map(function (message) {
          return '<p class="aiteam-memory__banner">' + escapeHtml(message) + '</p>';
        }).join('') + '</div>' +
        renderToolbar(items) +
        renderCards(items) +
        '</div>';
      bindEvents();
    }

    function promptValue(message, fallback) {
      if (typeof window === 'undefined' || typeof window.prompt !== 'function') return null;
      return window.prompt(message, fallback || '');
    }

    function confirmAction(message) {
      if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
      return window.confirm(message);
    }

    function createMemory() {
      var employeeId = state.employeeId || (collectEmployees(store.all())[0] || {}).employee_id || '';
      var content = promptValue('请输入记忆内容', '');
      if (!content) return;
      var payload = {
        employee_id: employeeId,
        content: content,
        importance: 3,
        category: 'preference',
        tags: []
      };
      if (!ns.api || !ns.api.createMemory) return;
      ns.api.createMemory(payload).then(function (result) {
        if (!result.ok) {
          state.bannerMessages = ['创建记忆失败：' + apiErrorMessage(result)];
          render();
          return;
        }
        store.upsert(result.data || payload);
        state.bannerMessages = ['已新增记忆，若自动提取链路失败可继续手动维护。'];
        render();
      });
    }

    function updateMemory(memoryId) {
      var current = store.all().find(function (item) { return item.memory_id === memoryId; });
      if (!current) return;
      var nextContent = promptValue('更新记忆内容', current.content);
      if (!nextContent || nextContent === current.content) return;
      if (!ns.api || !ns.api.updateMemory) return;
      ns.api.updateMemory(memoryId, { content: nextContent }).then(function (result) {
        if (!result.ok) {
          state.bannerMessages = ['更新记忆失败：' + apiErrorMessage(result)];
          render();
          return;
        }
        store.upsert(result.data || {
          memory_id: current.memory_id,
          employee_id: current.employee_id,
          employee_name: current.employee_name,
          content: nextContent,
          importance: current.importance,
          category: current.category,
          tags: current.tags,
          source: current.source,
          created_at: current.created_at,
          updated_at: current.updated_at,
          last_used_at: current.last_used_at,
          visibility_scope: current.visibility_scope,
          review_status: current.review_status,
          extraction_status: current.extraction_status,
          extraction_error_message: current.extraction_error_message,
          audit_events: current.audit_events,
          prompt_plan_refs: current.prompt_plan_refs,
        });
        state.bannerMessages = ['已更新记忆内容。'];
        render();
      });
    }

    function deleteMemory(memoryId) {
      if (!memoryId || !confirmAction('确认删除该条记忆吗？')) return;
      if (!ns.api || !ns.api.deleteMemory) return;
      ns.api.deleteMemory(memoryId).then(function (result) {
        if (!result.ok) {
          state.bannerMessages = ['删除记忆失败：' + apiErrorMessage(result)];
          render();
          return;
        }
        store.remove(memoryId);
        state.bannerMessages = ['已删除记忆。'];
        render();
      });
    }

    return {
      load: function (items) {
        store.replace(items);
        state.bannerMessages = [];
        render();
      },
      showError: function (message) {
        if (!container) return;
        container.innerHTML = '<div class="aiteam-shell__panel"><p class="aiteam-shell__panel-kicker">企业后台</p><h2 class="aiteam-shell__panel-title">记忆管理</h2><p class="aiteam-shell__panel-body">' + escapeHtml(message) + '</p></div>';
      },
      store: store,
      state: state,
      render: render
    };
  }

  ns.pages.adminMemories = {
    init: function (container) {
      if (!container) return;
      container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载记忆数据...</p></div>';
      var controller = createPageController(container);
      ns.api.getMemories().then(function (result) {
        if (!result.ok) {
          controller.showError(apiErrorMessage(result));
          return;
        }
        controller.load(normalizePayload(result.data));
      });
    },
    __test: {
      normalizeMemoryItem: normalizeMemoryItem,
      normalizePayload: normalizePayload,
      createStore: createStore,
      collectEmployees: collectEmployees,
      normalizeAuditEvents: normalizeAuditEvents,
      normalizePromptRefs: normalizePromptRefs,
    }
  };
}(window.aiteam));
