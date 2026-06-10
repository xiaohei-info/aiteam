window.aiteam = window.aiteam || {};

(function registerWorkbenchPage(ns) {
  ns.pages = ns.pages || {};
  var escapeHtml = (ns.util && ns.util.escapeHtml) || function (value) { return String(value == null ? '' : value); };

  function stringValue(value, fallback) {
    var text = String(value == null ? '' : value).trim();
    return text || (fallback || '');
  }

  function employeePresence(employee) {
    return stringValue(employee && (employee.presence || employee.status), 'idle').toLowerCase();
  }

  function employeePresenceLabel(employee) {
    var value = employeePresence(employee);
    var map = {
      active: '在线',
      online: '在线',
      busy: '忙碌',
      idle: '空闲',
      offline: '离线',
      waiting_reply: '待回复',
    };
    return map[value] || value;
  }

  function employeeListQuery(employee) {
    return [
      employee.display_name,
      employee.employee_id,
      employee.role_name,
      employee.last_message_preview,
    ].join(' ').toLowerCase();
  }

  function employeeSortKey(employee) {
    var ts = stringValue(employee && employee.last_active_at, '');
    return ts || '';
  }

  function sortEmployees(employees) {
    return (employees || []).slice().sort(function (left, right) {
      var leftStarred = !!(left && left.is_starred);
      var rightStarred = !!(right && right.is_starred);
      if (leftStarred !== rightStarred) return rightStarred ? 1 : -1;
      return employeeSortKey(right).localeCompare(employeeSortKey(left));
    });
  }

  function avatarFallback(employee) {
    var name = stringValue(employee && employee.display_name, employee && employee.employee_id, 'AI');
    return escapeHtml(name.slice(0, 1).toUpperCase());
  }

  function filterEmployees(employees, query) {
    var needle = stringValue(query, '').toLowerCase();
    if (!needle) return employees.slice();
    return employees.filter(function (employee) {
      return employeeListQuery(employee).indexOf(needle) !== -1;
    });
  }

  function quickLink(href, label, note) {
    return '<a class="aiteam-card-link" href="' + href + '">' +
      '<span class="aiteam-card-link__label">' + escapeHtml(label) + '</span>' +
      '<span class="aiteam-card-link__note">' + escapeHtml(note || '') + '</span>' +
      '</a>';
  }

  function resolveOnboardingHint(data) {
    if (data && data.onboarding_hint && data.onboarding_hint.action) {
      return data.onboarding_hint;
    }
    try {
      var search = window && window.location && window.location.search ? String(window.location.search) : '';
      var action = new URLSearchParams(search).get('onboarding');
      if (action === 'create_or_join_enterprise') {
        return {
          action: action,
          title: '完成企业入驻后再开始使用',
          message: '你已登录成功，下一步需要创建企业或加入已有企业空间。',
          primary_label: '创建企业',
          primary_target: '/admin/settings?tab=enterprise',
          secondary_label: '加入企业',
          secondary_target: '/admin/settings?tab=invites',
        };
      }
    } catch (_) {}
    return null;
  }

  function renderOnboardingHint(data) {
    var hint = resolveOnboardingHint(data);
    if (!hint) return '';
    return '' +
      '<article class="aiteam-card aiteam-card--onboarding" data-workbench-onboarding="1">' +
      '<div class="aiteam-card__row">' +
      '<div><p class="aiteam-workbench__eyebrow">登录成功 · 下一步</p><h3 class="aiteam-card__title">' + escapeHtml(hint.title || '完成企业入驻后再开始使用') + '</h3></div>' +
      '<span class="aiteam-badge">企业入驻</span>' +
      '</div>' +
      '<p class="aiteam-card__body">' + escapeHtml(hint.message || '你已登录成功，下一步需要创建企业或加入已有企业空间。') + '</p>' +
      '<div class="aiteam-hero-actions">' +
      '<a class="aiteam-button" href="' + escapeHtml(hint.primary_target || '/admin/settings?tab=enterprise') + '">' + escapeHtml(hint.primary_label || '创建企业') + '</a>' +
      '<a class="aiteam-button aiteam-button--ghost" href="' + escapeHtml(hint.secondary_target || '/admin/settings?tab=invites') + '">' + escapeHtml(hint.secondary_label || '加入企业') + '</a>' +
      '</div>' +
      '</article>';
  }

  function renderRail() {
    var items = [
      { key: 'chat', label: '私聊', title: '私聊', icon: '💬', href: '/app/workbench', active: true },
      { key: 'group', label: '群聊', title: '群聊', icon: '👥', href: '/app/group' },
      { key: 'org', label: '组织', title: '组织架构', icon: '🏢', href: '/app/org' },
      { key: 'knowledge', label: '知识库', title: '知识库', icon: '📚', href: '/app/knowledge' },
      { key: 'marketplace', label: '人才市场', title: '人才市场', icon: '🏪', href: '/app/marketplace' },
      { key: 'settings', label: '设置', title: '设置', icon: '⚙', href: '/admin/settings', bottom: true },
    ];
    return '' +
      '<nav class="aiteam-workbench__rail" data-workbench-rail="1" aria-label="工作台主入口">' +
      items.map(function (item) {
        return '<a class="aiteam-workbench__rail-link' + (item.active ? ' is-active' : '') + (item.bottom ? ' is-bottom' : '') + '" href="' + escapeHtml(item.href) + '" title="' + escapeHtml(item.title || item.label) + '" data-workbench-rail-item="' + escapeHtml(item.key) + '">' +
          '<span class="aiteam-workbench__rail-icon" aria-hidden="true">' + escapeHtml(item.icon) + '</span>' +
          '<span class="aiteam-workbench__rail-label">' + escapeHtml(item.label) + '</span>' +
          '</a>';
      }).join('') +
      '</nav>';
  }

  function renderEmployeeRow(employee, selected) {
    var presence = employeePresence(employee);
    var unread = Number(employee.unread_count) || 0;
    var chatHref = employee.conversation_id ? '/app/chat/' + encodeURIComponent(employee.conversation_id) : '/admin/employees/' + encodeURIComponent(employee.employee_id || '');
    var avatar = employee && employee.avatar_url
      ? '<img class="aiteam-workbench__avatar-image" data-workbench-avatar="1" src="' + escapeHtml(employee.avatar_url) + '" alt="' + escapeHtml(employee.display_name || employee.employee_id || '员工头像') + '">'
      : '<span class="aiteam-workbench__avatar-fallback" data-workbench-avatar="1">' + avatarFallback(employee) + '</span>';
    var starred = !!(employee && employee.is_starred);
    return '' +
      '<div class="aiteam-workbench__employee-row' + (selected ? ' is-selected' : '') + '">' +
      '<button type="button" class="aiteam-workbench__employee" data-select-employee="' + escapeHtml(employee.employee_id || '') + '">' +
      '<div class="aiteam-workbench__employee-head">' +
      '<div class="aiteam-workbench__employee-ident">' +
      '<span class="aiteam-workbench__avatar" data-workbench-avatar-wrap="1">' + avatar + '</span>' +
      '<span class="aiteam-workbench__presence is-' + escapeHtml(presence) + '"></span>' +
      '<strong>' + escapeHtml(employee.display_name || employee.employee_id || '未命名员工') + '</strong>' +
      (starred ? '<span class="aiteam-badge" data-workbench-starred="1">星标</span>' : '') +
      '</div>' +
      (unread ? '<span class="aiteam-workbench__unread">' + escapeHtml(String(unread)) + '</span>' : '') +
      '</div>' +
      '<div class="aiteam-workbench__employee-role">' + escapeHtml(employee.role_name || '待配置岗位') + '</div>' +
      '<div class="aiteam-workbench__employee-preview">' + escapeHtml(employee.last_message_preview || '暂无最近消息') + '</div>' +
      '</button>' +
      '<div class="aiteam-workbench__employee-actions">' +
      '<a class="aiteam-workbench__employee-link" href="' + escapeHtml(chatHref) + '">继续对话</a>' +
      '<button type="button" class="aiteam-workbench__employee-link" data-workbench-menu="' + escapeHtml(employee.employee_id || '') + '">快捷操作</button>' +
      '</div>' +
      '<div class="aiteam-workbench__context-menu" data-workbench-context-menu="' + escapeHtml(employee.employee_id || '') + '">' +
      '<a class="aiteam-workbench__employee-link" href="/admin/employees/' + encodeURIComponent(employee.employee_id || '') + '">查看详情</a>' +
      '<a class="aiteam-workbench__employee-link" href="/admin/employees/' + encodeURIComponent(employee.employee_id || '') + '?focus=star">设置为星标</a>' +
      '<a class="aiteam-workbench__employee-link" href="/admin/employees/' + encodeURIComponent(employee.employee_id || '') + '?action=dismiss">解雇</a>' +
      '</div>' +
      '</div>';
  }

  function renderGroups(groups) {
    if (!groups.length) {
      return '<div class="aiteam-inline-empty">还没有群聊协作会话，先在群聊页创建协作组。</div>';
    }
    return groups.map(function (group) {
      var href = group.conversation_id ? '/app/group/' + encodeURIComponent(group.conversation_id) : '/app/group';
      return '' +
        '<article class="aiteam-card aiteam-card--group">' +
        '<div class="aiteam-card__row"><div><h3 class="aiteam-card__title">' + escapeHtml(group.title || '未命名协作组') + '</h3>' +
        '<p class="aiteam-card__sub">成员 ' + escapeHtml(group.member_count || 0) + ' · 运行中 ' + escapeHtml(group.running_count || 0) + '</p></div>' +
        '<span class="aiteam-badge">群聊</span></div>' +
        '<p class="aiteam-card__body">' + escapeHtml(group.last_message_preview || '暂无群聊动态') + '</p>' +
        '<div class="aiteam-action-row">' + quickLink(href, '打开群聊', '查看时间线') + '</div>' +
        '</article>';
    }).join('');
  }

  function conversationTypeLabel(item) {
    return item && item.conv_type === 'group' ? '群聊' : '私聊';
  }

  function runStatusLabel(status) {
    var map = {
      queued: '排队中',
      routing: '路由中',
      submitting: '提交中',
      running: '运行中',
      waiting_human: '待回复',
      succeeded: '已完成',
      failed: '失败',
      cancelled: '已取消',
    };
    return map[String(status || '')] || stringValue(status, '未知');
  }

  function renderRecentConversations(items) {
    var conversations = Array.isArray(items) ? items : [];
    if (!conversations.length) {
      return '<div class="aiteam-inline-empty">最近会话会在产生私聊或群聊后显示在这里。</div>';
    }
    return conversations.slice(0, 4).map(function (item) {
      return '' +
        '<article class="aiteam-card aiteam-card--flat">' +
        '<div class="aiteam-card__row"><div><h3 class="aiteam-card__title">' + escapeHtml(item.title || '未命名会话') + '</h3>' +
        '<p class="aiteam-card__sub">' + escapeHtml(conversationTypeLabel(item)) + ' · ' + escapeHtml(stringValue(item.display_state, 'idle')) + '</p></div>' +
        '<span class="aiteam-badge">' + escapeHtml(runStatusLabel(item.latest_run_status)) + '</span></div>' +
        '<p class="aiteam-card__body">' + escapeHtml(item.last_preview || '暂无最近消息') + '</p>' +
        '<div class="aiteam-card__meta"><span>成员 ' + escapeHtml(String(item.member_count || 0)) + '</span><span>任务 ' + escapeHtml(String((item.task_status_digest && item.task_status_digest.total) || 0)) + '</span></div>' +
        '<div class="aiteam-action-row">' + quickLink(item.navigation_target || '/app/workbench', item.conv_type === 'group' ? '打开群聊' : '继续对话', '进入最近上下文') + '</div>' +
        '</article>';
    }).join('');
  }

  function renderTaskDigest(digest) {
    var value = digest || {};
    var rows = [
      { label: '运行中', value: Number(value.running) || 0 },
      { label: '排队中', value: Number(value.queued) || 0 },
      { label: '已完成', value: Number(value.succeeded) || 0 },
      { label: '失败', value: Number(value.failed) || 0 },
    ];
    return rows.map(function (row) {
      return '<div class="aiteam-detail-kv"><span>' + escapeHtml(row.label) + '</span><strong>' + escapeHtml(row.label + ' ' + String(row.value)) + '</strong></div>';
    }).join('');
  }

  function renderEmptyShell(enterpriseName) {
    return '' +
      '<section class="aiteam-workbench" data-workbench-shell="1">' +
      renderRail() +
      '<aside class="aiteam-workbench__sidebar">' +
      '<div class="aiteam-workbench__sidebar-top">' +
      '<p class="aiteam-page__eyebrow">P02 · 工作台</p>' +
      '<h2 class="aiteam-workbench__section-title">私聊</h2>' +
      '</div>' +
      '<div class="aiteam-workbench__empty" data-workbench-empty="1">' +
      '<div class="aiteam-workbench__empty-icon">🤖</div>' +
      '<strong>暂无数字员工</strong>' +
      '<p>前往人才市场招募</p>' +
      '<a class="aiteam-button" href="/app/marketplace">前往人才市场</a>' +
      '</div>' +
      '</aside>' +
      '<section class="aiteam-workbench__main" data-workbench-main="1">' +
      '<div class="aiteam-workbench__hero">' +
      '<div>' +
      '<h1 class="aiteam-workbench__hero-title">' + escapeHtml(enterpriseName || '企业工作台') + '</h1>' +
      '<p class="aiteam-workbench__hero-desc">从左侧选择员工开始对话，或前往人才市场招募你的第一个数字员工。</p>' +
      '</div>' +
      '<div class="aiteam-hero-actions">' +
      '<a class="aiteam-button" href="/app/marketplace">+ 前往人才市场</a>' +
      '<a class="aiteam-button aiteam-button--ghost" href="/app/org">查看组织架构</a>' +
      '</div>' +
      '</div>' +
      renderOnboardingHint({}) +
      '</section>' +
      '</section>';
  }

  function renderMainStage(data, state, selectedEmployee, filteredEmployees) {
    var enterprise = data.enterprise || {};
    var digest = data.office_digest || {};
    var groups = Array.isArray(data.groups) ? data.groups : [];
    var recentConversations = Array.isArray(data.recent_conversations) ? data.recent_conversations : [];
    var taskDigest = data.task_status_digest || {};
    var chatHref = selectedEmployee && selectedEmployee.conversation_id
      ? '/app/chat/' + encodeURIComponent(selectedEmployee.conversation_id)
      : '/admin/employees/' + encodeURIComponent((selectedEmployee && selectedEmployee.employee_id) || '');

    var employeePanel = selectedEmployee ? (
      '<div class="aiteam-workbench__employee-hero-card">' +
      '<div class="aiteam-workbench__employee-hero-top">' +
      '<div>' +
      '<p class="aiteam-workbench__eyebrow">当前选中员工</p>' +
      '<h3>' + escapeHtml(selectedEmployee.display_name || selectedEmployee.employee_id || '未命名员工') + '</h3>' +
      '<p>' + escapeHtml(selectedEmployee.role_name || '待配置岗位') + ' · ' + escapeHtml(employeePresenceLabel(selectedEmployee)) + '</p>' +
      '</div>' +
      '<span class="aiteam-badge">' + escapeHtml(employeePresenceLabel(selectedEmployee)) + '</span>' +
      '</div>' +
      '<p class="aiteam-workbench__hero-desc">' + escapeHtml(selectedEmployee.last_message_preview || '从这里继续当前员工的最近会话，或前往后台做深度配置。') + '</p>' +
      '<div class="aiteam-hero-actions">' +
      '<a class="aiteam-button" href="' + escapeHtml(chatHref) + '">继续对话</a>' +
      '<a class="aiteam-button aiteam-button--ghost" href="/admin/employees/' + encodeURIComponent(selectedEmployee.employee_id || '') + '">查看详情</a>' +
      '<a class="aiteam-button aiteam-button--ghost" href="/admin/employees">员工管理</a>' +
      '</div>' +
      '<div class="aiteam-workbench__quick-menu">' +
      '<span>快捷操作</span>' +
      '<div class="aiteam-workbench__quick-links">' +
      '<a href="/admin/employees/' + encodeURIComponent(selectedEmployee.employee_id || '') + '">查看详情</a>' +
      '<a href="/admin/employees">设置为星标</a>' +
      '<a href="/admin/employees">解雇</a>' +
      '</div>' +
      '</div>' +
      '</div>'
    ) : (
      '<div class="aiteam-workbench__employee-hero-card">' +
      '<p class="aiteam-workbench__hero-desc">从左侧选择员工开始对话。</p>' +
      '</div>'
    );

    return '' +
      '<section class="aiteam-workbench__main" data-workbench-main="1">' +
      '<div class="aiteam-workbench__hero">' +
      '<div>' +
      '<p class="aiteam-page__eyebrow">P02 · 工作台</p>' +
      '<h1 class="aiteam-workbench__hero-title">' + escapeHtml(enterprise.name || '企业工作台') + '</h1>' +
      '<p class="aiteam-workbench__hero-desc">从左侧列表进入私聊，在这里统一查看员工状态、群聊入口和任务摘要。</p>' +
      '</div>' +
      '<div class="aiteam-hero-actions">' +
      '<a class="aiteam-button" href="/app/marketplace">招募新成员</a>' +
      '<a class="aiteam-button aiteam-button--ghost" href="/app/org">查看组织架构</a>' +
      '</div>' +
      '</div>' +
      renderOnboardingHint(data) +
      '<div class="aiteam-workbench__metrics">' +
      '<div class="aiteam-workbench__metric"><span>在线员工</span><strong>' + escapeHtml(digest.online_employee_count || filteredEmployees.length || 0) + '</strong></div>' +
      '<div class="aiteam-workbench__metric"><span>运行中任务</span><strong>' + escapeHtml(digest.running_task_count || 0) + '</strong></div>' +
      '<div class="aiteam-workbench__metric"><span>群聊协作</span><strong>' + escapeHtml(groups.length) + '</strong></div>' +
      '<div class="aiteam-workbench__metric"><span>当前筛选</span><strong>' + escapeHtml(filteredEmployees.length) + '</strong></div>' +
      '</div>' +
      employeePanel +
      '<div class="aiteam-panel">' +
      '<div class="aiteam-panel__header"><h3>最近会话</h3><a href="' + escapeHtml(chatHref) + '">进入当前会话</a></div>' +
      '<div class="aiteam-stack">' + renderRecentConversations(recentConversations) + '</div>' +
      '</div>' +
      '<div class="aiteam-panel">' +
      '<div class="aiteam-panel__header"><h3>任务摘要</h3><a href="/app/office">查看办公室动态</a></div>' +
      '<div class="aiteam-stack">' +
      renderTaskDigest(taskDigest) +
      '</div>' +
      '</div>' +
      '<div class="aiteam-panel">' +
      '<div class="aiteam-panel__header"><h3>最近群聊</h3><a href="/app/group">进入群聊</a></div>' +
      '<div class="aiteam-stack">' + renderGroups(groups) + '</div>' +
      '</div>' +
      '</section>';
  }

  function renderWorkbench(container, data, state) {
    var employees = sortEmployees(Array.isArray(data.employees) ? data.employees : []);
    var filteredEmployees = filterEmployees(employees, state.query);
    var enterprise = data.enterprise || {};

    if (!employees.length) {
      container.innerHTML = renderEmptyShell(enterprise.name || '企业工作台');
      return;
    }

    if (!state.selectedEmployeeId || !filteredEmployees.some(function (employee) { return employee.employee_id === state.selectedEmployeeId; })) {
      state.selectedEmployeeId = filteredEmployees.length ? filteredEmployees[0].employee_id : '';
    }

    var selectedEmployee = filteredEmployees.find(function (employee) {
      return employee.employee_id === state.selectedEmployeeId;
    }) || employees[0] || null;

    container.innerHTML =
      '<section class="aiteam-workbench" data-workbench-shell="1">' +
      renderRail() +
      '<aside class="aiteam-workbench__sidebar">' +
      '<div class="aiteam-workbench__sidebar-top">' +
      '<div>' +
      '<p class="aiteam-page__eyebrow">P02 · 工作台</p>' +
      '<h2 class="aiteam-workbench__section-title">私聊</h2>' +
      '</div>' +
      '<input class="aiteam-input aiteam-workbench__search" data-workbench-search="1" type="search" placeholder="搜索员工或岗位..." value="' + escapeHtml(state.query || '') + '">' +
      '</div>' +
      '<div class="aiteam-workbench__list" data-workbench-list="1">' +
      (filteredEmployees.length
        ? filteredEmployees.map(function (employee) {
            return renderEmployeeRow(employee, employee.employee_id === state.selectedEmployeeId);
          }).join('')
        : '<div class="aiteam-workbench__empty-mini">当前筛选下没有匹配员工</div>') +
      '</div>' +
      '<div class="aiteam-workbench__sidebar-actions">' +
      quickLink('/app/marketplace', '前往人才市场', '继续招募') +
      quickLink('/app/office', '办公室动态', '查看状态') +
      '</div>' +
      '</aside>' +
      renderMainStage(data, state, selectedEmployee, filteredEmployees) +
      '</section>';
  }

  function bindEvents(container, data, state) {
    if (!container || typeof container.querySelector !== 'function') return;
    var searchInput = container.querySelector('[data-workbench-search]');
    if (searchInput && searchInput.addEventListener) {
      searchInput.addEventListener('input', function () {
        state.query = this.value || '';
        renderWorkbench(container, data, state);
        bindEvents(container, data, state);
      });
    }

    if (!container.querySelectorAll) return;
    var buttons = container.querySelectorAll('[data-select-employee]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].addEventListener('click', function () {
        state.selectedEmployeeId = this.getAttribute('data-select-employee') || '';
        renderWorkbench(container, data, state);
        bindEvents(container, data, state);
      });
    }
  }

  function mountWorkbench(container, data) {
    var employees = Array.isArray(data && data.employees) ? data.employees : [];
    var state = {
      query: '',
      selectedEmployeeId: employees.length ? employees[0].employee_id : '',
    };
    renderWorkbench(container, data || {}, state);
    bindEvents(container, data || {}, state);
  }

  ns.pages.appWorkbench = {
    render: function (container, data) {
      mountWorkbench(container, data || {});
    },
    init: function (container) {
      if (!container) return;
      ns.states.renderLoading(container, '加载工作台聚合视图...');
      ns.api.getWorkbench().then(function (result) {
        if (!result.ok) {
          ns.states.handleApiResult(result, container, function () {});
          return;
        }
        mountWorkbench(container, result.data || {});
      });
    },
  };
}(window.aiteam));
