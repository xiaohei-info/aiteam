window.aiteam = window.aiteam || {};

(function registerGroupPage(ns) {
  ns.pages = ns.pages || {};
  var escapeHtml = (ns.util && ns.util.escapeHtml) || function (value) { return String(value == null ? '' : value); };
  var GROUP_SENDER_STORAGE_KEY = 'aiteam-group-sender-id';

  function getConversationId(pathname) {
    var parts = String(pathname || window.location.pathname || '').split('/');
    return parts.length >= 4 ? decodeURIComponent(parts[3]) : '';
  }

  function stringValue(value, fallback) {
    var text = String(value == null ? '' : value).trim();
    return text || (fallback || '');
  }

  function listValue(value) {
    return Array.isArray(value) ? value : [];
  }

  function mentionHandle(member) {
    var raw = member && (member.profile_name || member.display_name || member.employee_id || member.member_ref_id || member.member_id);
    raw = stringValue(raw, 'member');
    return '@' + raw.replace(/^@+/, '').replace(/\s+/g, '_');
  }

  function memberLabel(member) {
    return stringValue(member && (member.display_name || member.employee_id || member.member_ref_id || member.member_id), '未命名成员');
  }

  function memberRole(member) {
    if (!member) return '成员';
    if (member.is_human) return '人类成员';
    return stringValue(member.role_name || member.role, '数字员工');
  }

  function memberStatus(member) {
    if (!member) return 'unknown';
    return stringValue(member.employee_status || member.status || 'unknown');
  }

  function routeModeLabel(mode) {
    var map = {
      auto: '自动路由',
      single_agent: '单员工优先',
      orchestration: '多员工协作',
    };
    return map[String(mode || 'auto')] || String(mode || 'auto');
  }

  function routeModeDescription(mode) {
    var map = {
      auto: '由系统根据消息内容、@提及与成员能力，自动决定单员工执行或多员工协作。',
      single_agent: '本轮消息会优先路由到单个数字员工，不展开任务树协作。',
      orchestration: '本轮消息会进入协作编排，由多个数字员工拆解任务并合并结果。',
    };
    return map[String(mode || 'auto')] || '等待新的协作决策。';
  }

  function routeModeClass(mode) {
    var value = String(mode || 'auto');
    return value === 'orchestration' ? 'is-multi' : (value === 'single_agent' ? 'is-single' : 'is-auto');
  }

  function runtimeHandleLabel(runtimeHandle) {
    if (!runtimeHandle || !runtimeHandle.kind) return '等待本轮执行';
    if (runtimeHandle.kind === 'session') return '单员工会话';
    if (runtimeHandle.kind === 'kanban_task') return '协作根任务';
    return stringValue(runtimeHandle.kind, '运行句柄');
  }

  function collaborationModeLabel(count) {
    if (count > 1) return '多人协作偏好';
    if (count === 1) return '单人协作偏好';
    return '未指定提及';
  }

  function taskStatusLabel(status) {
    var map = {
      planned: '待规划',
      queued: '排队中',
      running: '执行中',
      succeeded: '已完成',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
      task_created: '已创建',
      task_started: '执行中',
      task_completed: '已完成',
      task_failed: '失败',
    };
    return map[String(status || '')] || stringValue(status, '待命');
  }

  function eventTypeLabel(eventType) {
    var map = {
      routing_decided: '路由完成',
      run_started: '协作开始',
      task_created: '任务创建',
      task_started: '任务执行',
      task_completed: '任务完成',
      task_failed: '任务失败',
      result_merged: '结果合并',
      run_waiting_human: '等待人工',
      run_failed: '协作失败',
      run_succeeded: '协作完成',
      heartbeat: '协作心跳',
      error: '异常',
    };
    return map[String(eventType || '')] || stringValue(eventType, '时间线事件');
  }

  function eventPreview(event, fallback) {
    if (!event) return fallback || '已记录';
    var payload = event.payload || {};
    return stringValue(event.preview || payload.text || payload.summary || payload.message || payload.result || payload.note, fallback || '已记录');
  }

  function badge(text) {
    return '<span class="aiteam-badge">' + escapeHtml(text) + '</span>';
  }

  function messageMeta(title, speakerLabel, kindLabel) {
    var speaker = stringValue(speakerLabel || title, '系统');
    var initial = speaker.slice(0, 1) || '?';
    return '<div class="aiteam-message__speaker"><span class="aiteam-message__avatar">' + escapeHtml(initial) + '</span><span class="aiteam-message__speaker-name">' + escapeHtml(speaker) + '</span></div>' +
      '<span class="aiteam-message__kind">' + escapeHtml(kindLabel || title) + '</span>';
  }

  function messageBubble(role, title, body, extraClass, speakerLabel, kindLabel) {
    return '<article class="aiteam-message aiteam-message--' + role + (extraClass ? ' ' + extraClass : '') + '">' +
      '<div class="aiteam-message__meta">' + messageMeta(title, speakerLabel, kindLabel) + '</div>' +
      '<div class="aiteam-message__body">' + body + '</div>' +
      '</article>';
  }

  function timelineRow(event, state) {
    var payload = event.payload || {};
    var actor = memberLabel(state.memberMap[event.employee_id]) || stringValue(event.employee_id, '');
    var routeMode = payload.route_mode || (payload.route_decision && payload.route_decision.route_mode) || (state.conversation.latest_route_decision && state.conversation.latest_route_decision.route_mode) || 'auto';
    var meta = [];
    if (actor) meta.push(actor);
    if (/^task_/.test(String(event.event_type || ''))) {
      meta.push(routeModeLabel(routeMode));
    }
    return '<div class="aiteam-timeline-row aiteam-timeline-row--' + escapeHtml(String(event.event_type || 'timeline')) + '">' +
      '<div class="aiteam-timeline-row__top">' +
      '<span class="aiteam-timeline-row__pill aiteam-timeline-row__pill--' + routeModeClass(routeMode) + '">' + escapeHtml(eventTypeLabel(event.event_type || 'timeline')) + '</span>' +
      '</div>' +
      '<strong>' + escapeHtml(eventPreview(event, '已记录')) + '</strong>' +
      (meta.length ? '<div class="aiteam-timeline-row__meta">' + escapeHtml(meta.join(' · ')) + '</div>' : '') +
      '</div>';
  }

  function taskSummary(task) {
    var bits = [];
    if (task.employeeLabel) bits.push(task.employeeLabel);
    if (task.phase) bits.push(task.phase);
    if (task.routeModeLabel) bits.push(task.routeModeLabel);
    return bits.join(' · ');
  }

  function renderTaskItem(task) {
    var depth = Number(task.depth) || 0;
    var indent = Math.max(0, Math.min(depth, 5)) * 18;
    var childCount = Number(task.childCount) || 0;
    var runtimeText = task.runtimeTaskId ? '<span class="aiteam-task-tree__runtime" data-runtime-task="' + escapeHtml(task.runtimeTaskId) + '"></span>' : '';
    var childText = childCount ? '<span class="aiteam-task-tree__children">子任务 ' + escapeHtml(String(childCount)) + '</span>' : '';
    return '<li class="aiteam-task-tree__item aiteam-task-tree__item--' + routeModeClass(task.routeMode) + '" style="--task-depth:' + depth + ';margin-left:' + indent + 'px">' +
      '<div class="aiteam-task-tree__rail"></div>' +
      '<span class="aiteam-badge aiteam-badge--task">' + escapeHtml(taskStatusLabel(task.statusLabel || task.status || 'task')) + '</span>' +
      '<div class="aiteam-task-tree__body">' +
      '<div class="aiteam-task-tree__title-row"><strong>' + escapeHtml(task.title || '协作任务') + '</strong>' + childText + runtimeText + '</div>' +
      '<span>' + escapeHtml(taskSummary(task) || task.preview || '等待任务事件') + '</span>' +
      (task.preview ? '<p class="aiteam-task-tree__preview">' + escapeHtml(task.preview) + '</p>' : '') +
      '</div>' +
      '</li>';
  }

  // 成员栏 — 紧凑行：头像 + 名称/角色 + 状态点 + @提及按钮。
  function renderMemberCard(member) {
    var handle = mentionHandle(member);
    var status = memberStatus(member);
    var dotClass = (status === 'busy' || status === 'running') ? 'is-busy' : ((status === 'offline' || status === 'paused') ? 'is-offline' : 'is-online');
    var initial = memberLabel(member).slice(0, 1) || '?';
    var detailLink = member.employee_id
      ? '<a class="aiteam-group-member__link" href="/admin/employees/' + encodeURIComponent(member.employee_id) + '" title="成员详情">⚙</a>'
      : '';
    return '<div class="aiteam-group-member" data-member-id="' + escapeHtml(member.member_id || member.employee_id || '') + '">' +
      '<div class="aiteam-chat__agent-avatar">' + escapeHtml(initial) + '<span class="aiteam-chat__agent-dot ' + dotClass + '"></span></div>' +
      '<div class="aiteam-group-member__info"><div class="aiteam-group-member__name">' + escapeHtml(memberLabel(member)) + '</div>' +
      '<div class="aiteam-group-member__role">' + escapeHtml(memberRole(member)) + '</div></div>' +
      '<button class="aiteam-chatwin__tool" type="button" data-mention="' + escapeHtml(handle) + '" data-mention-id="' + escapeHtml(stringValue(member.employee_id || member.member_ref_id || member.member_id, '')) + '" title="插入提及">@</button>' +
      detailLink +
      '</div>';
  }

  function renderGroupAvatarGrid(members) {
    var previewMembers = listValue(members).slice(0, 4);
    if (!previewMembers.length) {
      return '<div class="aiteam-inline-empty">暂无可展示成员</div>';
    }
    return '<div class="aiteam-group-avatar-grid" aria-label="群聊头像 2×2 宫格">' + previewMembers.map(function (member) {
      var initial = memberLabel(member).slice(0, 1) || '?';
      return '<div class="aiteam-group-avatar-grid__cell"><strong>' + escapeHtml(initial) + '</strong><span>' + escapeHtml(memberLabel(member)) + '</span></div>';
    }).join('') + '</div>';
  }

  function removableMemberOptions(members) {
    var removable = listValue(members).filter(function (member) {
      return stringValue(member.member_id, '');
    });
    if (!removable.length) {
      return '<option value="">当前没有可移除成员</option>';
    }
    return removable.map(function (member) {
      return '<option value="' + escapeHtml(stringValue(member.member_id, '')) + '">' + escapeHtml(memberLabel(member)) + ' · ' + escapeHtml(memberRole(member)) + '</option>';
    }).join('');
  }

  function renderLatestDecision(decision, state) {
    if (!decision) {
      return '<div class="aiteam-card"><div class="aiteam-card__row"><strong>最近协作决策</strong>' + badge('暂无') + '</div><p class="aiteam-card__sub">发送首条群聊消息后，这里会显示协作方式与参与成员。</p></div>';
    }
    var targets = listValue(decision.candidate_employee_ids || decision.target_employee_ids).map(function (employeeId) {
      return memberLabel(state.memberMap[employeeId]) || employeeId;
    });
    return '<div class="aiteam-card">' +
      '<div class="aiteam-card__row"><strong>最近协作决策</strong>' + badge(routeModeLabel(decision.route_mode)) + '</div>' +
      '<div class="aiteam-detail-kv"><span>入口员工</span><strong>' + escapeHtml(memberLabel(state.memberMap[decision.entry_employee_id]) || decision.entry_employee_id || '未指定') + '</strong></div>' +
      '<div class="aiteam-detail-kv"><span>编排员工</span><strong>' + escapeHtml(memberLabel(state.memberMap[decision.planner_employee_id]) || decision.planner_employee_id || '未指定') + '</strong></div>' +
      '<div class="aiteam-detail-kv"><span>候选协作成员</span><strong>' + escapeHtml(targets.join('、') || '按 Router Agent 动态决定') + '</strong></div>' +
      '</div>';
  }

  function renderLatestRunSummary(summary) {
    if (!summary || (!summary.summary && !(summary.citations && summary.citations.length))) {
      return '';
    }
    var citations = Array.isArray(summary.citations) ? summary.citations : [];
    return '<div class="aiteam-card aiteam-card--flat">' +
      '<div class="aiteam-card__row"><strong>最近知识引用</strong>' + badge(citations.length ? ('引用 ' + citations.length) : '摘要') + '</div>' +
      '<p class="aiteam-card__sub">' + escapeHtml(summary.summary || '已生成知识库引用摘要') + '</p>' +
      (citations.length ? '<div class="aiteam-route-feedback__chips">' + citations.map(function (item) { return badge(item.title || item.label || '引用来源'); }).join('') + '</div>' : '') +
      '</div>';
  }

  function routeDecisionMessage(event, state) {
    var payload = event.payload || {};
    var decision = payload.route_decision || state.conversation.latest_route_decision || {};
    var targets = listValue(decision.candidate_employee_ids || decision.target_employee_ids).map(function (employeeId) {
      return memberLabel(state.memberMap[employeeId]) || employeeId;
    });
    var routeMode = decision.route_mode || payload.route_mode || 'auto';
    var entryLabel = memberLabel(state.memberMap[decision.entry_employee_id]) || decision.entry_employee_id;
    var plannerLabel = memberLabel(state.memberMap[decision.planner_employee_id]) || decision.planner_employee_id;
    return messageBubble(
      'system',
      '路由决策',
      '<div class="aiteam-route-decision aiteam-route-decision--' + routeModeClass(routeMode) + '">' +
      '<p>正在分配员工/决定协作方式：<strong>' + escapeHtml(routeModeLabel(routeMode)) + '</strong></p>' +
      '<p class="aiteam-route-decision__desc">' + escapeHtml(routeModeDescription(routeMode)) + '</p>' +
      '<div class="aiteam-chip-row">' +
      badge(targets.join('、') || '等待候选成员') +
      (entryLabel ? badge('入口：' + entryLabel) : '') +
      (plannerLabel ? badge('编排：' + plannerLabel) : '') +
      '</div>' +
      '</div>',
      '',
      '系统',
      '路由决策'
    );
  }

  function resultMergedMessage(event, state) {
    var payload = event.payload || {};
    var employeeId = payload.employee_id || event.employee_id;
    var author = memberLabel(state.memberMap[employeeId]) || stringValue(employeeId, '协作结果');
    return messageBubble(
      'assistant',
      author,
      '<p>' + escapeHtml(eventPreview(event, '协作结果已合并')) + '</p>' +
      '<div class="aiteam-chip-row">' + badge('result_merged') + (employeeId ? badge(employeeId) : '') + '</div>',
      '',
      author,
      '协作结果'
    );
  }

  function normalizeTaskEvent(event, state) {
    var payload = event.payload || {};
    var id = stringValue(event.source_id || payload.task_id || payload.parent_task_id, 'timeline-task-' + String(event.event_cursor || Date.now()));
    var routeMode = payload.route_mode || payload.execution_mode || (state.conversation.latest_route_decision && state.conversation.latest_route_decision.route_mode) || 'auto';
    return {
      id: id,
      title: eventPreview(event, '协作任务'),
      preview: eventPreview(event, '协作任务'),
      status: stringValue(event.event_type, 'task_event'),
      statusLabel: stringValue(event.event_type, 'task_event'),
      employeeLabel: memberLabel(state.memberMap[event.employee_id]) || stringValue(event.employee_id, ''),
      phase: stringValue(payload.phase, ''),
      parentTaskId: stringValue(payload.parent_task_id || payload.parent_runtime_task_id, ''),
      runtimeTaskId: stringValue(payload.runtime_task_id || event.source_id, ''),
      routeMode: routeMode,
      routeModeLabel: routeModeLabel(routeMode),
      depth: Number(payload.depth) || 0,
      childCount: 0,
    };
  }

  // ── 左侧数字员工/群组列表（与消息中心一致的渲染，群聊页独立加载时复用同一套 class） ──
  var lastListSections = { pinned: [], groups: [], others: [] };

  function presenceDotClass(status) {
    var s = String(status || '').toLowerCase();
    if (s === 'busy' || s === 'running' || s === 'streaming') return 'is-busy';
    if (s === 'offline' || s === 'paused') return 'is-offline';
    return 'is-online';
  }

  function renderListAgentItem(a, activeConversationId) {
    var convId = a.conversation_id || '';
    var active = convId && String(convId) === String(activeConversationId) ? ' is-active' : '';
    var href = convId ? '/app/chat/' + encodeURIComponent(convId) : '/app/chat/' + encodeURIComponent(a.employee_id || '');
    var unread = a.unread_count ? '<div class="aiteam-chat__agent-unread">' + escapeHtml(String(a.unread_count)) + '</div>' : '';
    return '<a class="aiteam-chat__agent' + active + '" href="' + escapeHtml(href) + '" data-chat-agent="' + escapeHtml(a.employee_id || '') + '">' +
      '<div class="aiteam-chat__agent-avatar" style="background:' + escapeHtml(a.avatar_bg || 'linear-gradient(135deg,#2563EB,#0EA5E9)') + '">' + escapeHtml(a.avatar || '🤖') +
      '<span class="aiteam-chat__agent-dot ' + presenceDotClass(a.status) + '"></span></div>' +
      '<div class="aiteam-chat__agent-info"><div class="aiteam-chat__agent-name">' + escapeHtml(a.display_name || a.employee_id || '智能体') + '</div>' +
      '<div class="aiteam-chat__agent-role">' + escapeHtml(a.role_name || '数字员工') + '</div></div>' +
      '<div class="aiteam-chat__agent-meta"><div class="aiteam-chat__agent-time">' + escapeHtml(a.time_label || '') + '</div>' + unread + '</div>' +
      '</a>';
  }

  function renderListGroupItem(g, activeConversationId) {
    var convId = g.conversation_id || '';
    var active = convId && String(convId) === String(activeConversationId) ? ' is-active' : '';
    var href = convId ? '/app/group/' + encodeURIComponent(convId) : '/app/group';
    var unread = g.unread_count ? '<div class="aiteam-chat__agent-unread">' + escapeHtml(String(g.unread_count)) + '</div>' : '';
    var role = (g.member_count != null ? (g.member_count + '位成员') : '协作组') + (g.running_count ? ' · ' + g.running_count + '个任务运行中' : '');
    return '<a class="aiteam-chat__agent' + active + '" href="' + escapeHtml(href) + '" data-chat-group="' + escapeHtml(convId) + '">' +
      '<div class="aiteam-chat__agent-avatar" style="background:' + escapeHtml(g.avatar_bg || 'linear-gradient(135deg,#F59E0B,#F0883E)') + '">' + escapeHtml(g.avatar || '👥') +
      '<span class="aiteam-chat__agent-dot ' + presenceDotClass(g.status) + '"></span></div>' +
      '<div class="aiteam-chat__agent-info"><div class="aiteam-chat__agent-name">' + escapeHtml(g.title || '协作组') + '</div>' +
      '<div class="aiteam-chat__agent-role">' + escapeHtml(role) + '</div></div>' +
      '<div class="aiteam-chat__agent-meta"><div class="aiteam-chat__agent-time">' + escapeHtml(g.time_label || '') + '</div>' + unread + '</div>' +
      '</a>';
  }

  function renderListSections(sections, activeConversationId) {
    sections = sections || {};
    var pinned = sections.pinned || [];
    var groups = sections.groups || [];
    var others = sections.others || [];
    if (!pinned.length && !groups.length && !others.length) {
      return '<div class="aiteam-chat__agent-list"><div class="aiteam-inline-empty">暂无可用智能体</div></div>';
    }
    var html = '';
    if (pinned.length) {
      html += '<div class="aiteam-chat__group-label">📌 置顶</div>' + pinned.map(function (a) { return renderListAgentItem(a, activeConversationId); }).join('');
    }
    if (groups.length) {
      html += '<div class="aiteam-chat__group-label">💼 工作群组</div>' + groups.map(function (g) { return renderListGroupItem(g, activeConversationId); }).join('');
    }
    if (others.length) {
      html += '<div class="aiteam-chat__group-label">🤖 其他智能体</div>' + others.map(function (a) { return renderListAgentItem(a, activeConversationId); }).join('');
    }
    return '<div class="aiteam-chat__agent-list">' + html + '</div>';
  }

  function mapWorkbenchToListSections(data) {
    data = data || {};
    var employees = Array.isArray(data.employees) ? data.employees : [];
    var rawGroups = Array.isArray(data.groups) ? data.groups : [];
    var pinned = [];
    var others = [];
    employees.forEach(function (e) {
      var agent = {
        employee_id: e.employee_id,
        display_name: e.display_name,
        role_name: e.role_name,
        status: e.presence || e.status,
        conversation_id: e.conversation_id,
        avatar: e.avatar || '🤖',
        avatar_bg: e.avatar_bg,
        unread_count: e.unread_count,
        time_label: e.time_label,
      };
      if (e.pinned || e.is_starred) pinned.push(agent); else others.push(agent);
    });
    var groups = rawGroups.map(function (g) {
      return {
        conversation_id: g.conversation_id,
        title: g.title,
        member_count: g.member_count,
        running_count: g.running_count,
        status: g.presence || g.status,
        avatar: g.avatar,
        avatar_bg: g.avatar_bg,
        unread_count: g.unread_count,
        time_label: g.time_label,
      };
    });
    return { pinned: pinned, groups: groups, others: others };
  }

  // 打开会话后，把左栏列表里该会话的未读数本地清零（与服务端 mark_read 对应）。
  function markConversationReadInSections(sections, conversationId) {
    sections = sections || {};
    var targetId = String(conversationId || '');
    function clearUnread(list) {
      var items = Array.isArray(list) ? list : [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i] || {};
        if (String(item.conversation_id || '') === targetId) {
          item.unread_count = 0;
        }
      }
    }
    clearUnread(sections.pinned);
    clearUnread(sections.groups);
    clearUnread(sections.others);
    return sections;
  }

  // 进入群聊会话时，如该会话仍有未读则持久化已读并清零本地徽标，避免切换后残留。
  function syncOpenedConversationRead(conversationId, sections, onDone) {
    var targetId = String(conversationId || '');
    if (!targetId || !ns.api || typeof ns.api.updateWorkbenchState !== 'function') {
      if (typeof onDone === 'function') onDone(sections || null);
      return;
    }
    var currentSections = sections || { pinned: [], groups: [], others: [] };
    var lists = []
      .concat(Array.isArray(currentSections.pinned) ? currentSections.pinned : [])
      .concat(Array.isArray(currentSections.groups) ? currentSections.groups : [])
      .concat(Array.isArray(currentSections.others) ? currentSections.others : []);
    var hasUnread = lists.some(function (item) {
      return String(item && item.conversation_id || '') === targetId && Number(item && item.unread_count) > 0;
    });
    if (!hasUnread) {
      if (typeof onDone === 'function') onDone(currentSections);
      return;
    }
    ns.api.updateWorkbenchState({ conversation_id: targetId, mark_read: true }).then(function (result) {
      if (result && result.ok) markConversationReadInSections(currentSections, targetId);
      if (typeof onDone === 'function') onDone(currentSections);
    }).catch(function () {
      if (typeof onDone === 'function') onDone(currentSections);
    });
  }

  function bindListSearch(container) {
    var search = container.querySelector && container.querySelector('[data-chat-agent-search]');
    if (!search || typeof search.addEventListener !== 'function') return;
    search.addEventListener('input', function () {
      var query = String(search.value || '').toLowerCase();
      Array.prototype.slice.call(container.querySelectorAll('.aiteam-chat__agent')).forEach(function (item) {
        var nameEl = item.querySelector('.aiteam-chat__agent-name');
        var name = nameEl ? String(nameEl.textContent || '').toLowerCase() : '';
        item.style.display = name.indexOf(query) !== -1 ? '' : 'none';
      });
    });
  }

  function renderGroupLauncher(container) {
    var launcherState = {
      title: '新建群聊',
      employeeItems: [],
      selectedEmployeeIds: [],
      limitMessage: '',
    };

    function renderLauncher() {
      var isAtLimit = launcherState.selectedEmployeeIds.length >= 10;
      var canCreate = launcherState.selectedEmployeeIds.length >= 2 && !!stringValue(launcherState.title, '');
      var selectedLabels = launcherState.employeeItems.filter(function (employee) {
        return launcherState.selectedEmployeeIds.indexOf(stringValue(employee && employee.employee_id, '')) !== -1;
      }).map(function (employee) {
        return stringValue(employee && employee.display_name, stringValue(employee && employee.employee_id, '未命名员工'));
      });
      var memberCards = launcherState.employeeItems.length
        ? launcherState.employeeItems.map(function (employee) {
            var employeeId = stringValue(employee && employee.employee_id, '');
            var checked = launcherState.selectedEmployeeIds.indexOf(employeeId) !== -1 ? ' checked' : '';
            var disabled = !checked && isAtLimit ? ' disabled' : '';
            return '<label class="aiteam-card aiteam-card--flat">' +
              '<div class="aiteam-card__row"><strong>' + escapeHtml(stringValue(employee.display_name, employeeId || '未命名员工')) + '</strong>' + badge(stringValue(employee.role_name, '数字员工')) + '</div>' +
              '<div class="aiteam-card__meta"><span>' + escapeHtml(stringValue(employee.status || employee.presence, 'active')) + '</span><span>' + escapeHtml(employeeId) + '</span></div>' +
              '<div class="aiteam-action-row"><input type="checkbox" data-group-create-member="' + escapeHtml(employeeId) + '"' + checked + disabled + '> <span>加入群聊</span></div>' +
              '</label>';
          }).join('')
        : '<div class="aiteam-inline-empty">当前暂无可选成员</div>';

      container.innerHTML = '<section class="aiteam-page aiteam-page--chat aiteam-group-page">' +
      '<div class="aiteam-page__hero">' +
      '<div>' +
      '<h2 class="aiteam-page__title">新建群聊</h2>' +
      '<p class="aiteam-page__desc">选择至少 2 位数字员工组建工作群组，群聊会出现在消息中心列表中。</p>' +
      '</div>' +
      '<div class="aiteam-hero-actions"><a class="aiteam-button aiteam-button--ghost" href="/app/chat">返回消息中心</a></div>' +
      '</div>' +
      '<div class="aiteam-panel">' +
      '<div class="aiteam-panel__header"><h3>创建群聊</h3><span class="aiteam-inline-note" data-group-create-status>' + escapeHtml(launcherState.limitMessage || '填写标题与成员后创建') + '</span></div>' +
      '<div class="aiteam-shell__meta">' +
      '<div class="aiteam-shell__meta-card"><label>群聊标题<br><input class="aiteam-input" type="text" data-group-create-title value="' + escapeHtml(launcherState.title) + '" placeholder="例如：新品启动群"></label></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">可选成员</span><span class="aiteam-shell__meta-value">最多 10 人，当前已选 ' + escapeHtml(String(launcherState.selectedEmployeeIds.length)) + ' 人</span><br><span class="aiteam-inline-note">已选成员：' + escapeHtml(selectedLabels.join('、') || '未选择') + '</span></div>' +
      '</div>' +
      '<div class="aiteam-stack" data-group-create-members>' + memberCards + '</div>' +
      '<div class="aiteam-action-row">' +
      '<button class="aiteam-button" type="button" data-group-create-launch' + (canCreate ? '' : ' disabled') + '>立即创建</button>' +
      '</div>' +
      '</div>' +
      '</section>';
    }

    var statusEl = container.querySelector('[data-group-create-status]');
    function setStatus(text) {
      if (statusEl) statusEl.textContent = text || '';
    }

    container.lastCreateGroupHandler = function (payload) {
      if (!ns.api || !ns.api.createGroupConversation) {
        setStatus('当前 API client 未接入 createGroupConversation。');
        return Promise.resolve({ ok: false, status: 0, error: 'missing_createGroupConversation' });
      }
      setStatus('正在创建群聊...');
      return ns.api.createGroupConversation(payload || {}).then(function (result) {
        if (!result.ok) {
          setStatus(result.error || '群聊创建失败');
          return result;
        }
        var conversationId = result.data && result.data.conversation_id;
        if (!conversationId) {
          setStatus('群聊已创建，但响应缺少 conversation_id');
          return result;
        }
        return ns.api.getGroupConversation(conversationId).then(function (detailResult) {
          if (!detailResult.ok) {
            setStatus(detailResult.error || '群聊详情加载失败');
            return detailResult;
          }
          renderGroup(container, detailResult.data || {});
          return detailResult;
        });
      });
    };

    container.lastLoadEmployeesHandler = function () {
      if (!ns.api || !ns.api.getEmployees) {
        renderLauncher();
        setStatus('当前 API client 未接入 getEmployees。');
        return Promise.resolve({ ok: false, status: 0, error: 'missing_getEmployees' });
      }
      return ns.api.getEmployees().then(function (result) {
        if (!result.ok) {
          renderLauncher();
          setStatus(result.error || '成员列表加载失败');
          return result;
        }
        var payload = result.data || {};
        launcherState.employeeItems = listValue(payload.items || payload.employees || payload);
        if (!launcherState.selectedEmployeeIds.length) {
          launcherState.selectedEmployeeIds = launcherState.employeeItems.slice(0, 2).map(function (item) {
            return stringValue(item && item.employee_id, '');
          }).filter(Boolean);
        }
        renderLauncher();
        bindLauncherInteractions();
        return result;
      });
    };

    function bindLauncherInteractions() {
      var titleInput = container.querySelector('[data-group-create-title]');
      if (titleInput && typeof titleInput.addEventListener === 'function') {
        titleInput.addEventListener('input', function () {
          launcherState.title = this.value || '';
          if (!stringValue(launcherState.title, '')) {
            launcherState.limitMessage = '请输入群聊标题';
          } else {
            launcherState.limitMessage = launcherState.selectedEmployeeIds.length < 2 ? '至少选择 2 名成员' : '';
          }
          renderLauncher();
          bindLauncherInteractions();
        });
      }
      var memberInputs = container.querySelectorAll ? container.querySelectorAll('[data-group-create-member]') : [];
      for (var i = 0; i < memberInputs.length; i += 1) {
        memberInputs[i].addEventListener('change', function () {
          var employeeId = this.getAttribute('data-group-create-member') || '';
          if (!employeeId) return;
          if (this.checked) {
            if (launcherState.selectedEmployeeIds.indexOf(employeeId) === -1 && launcherState.selectedEmployeeIds.length < 10) {
              launcherState.selectedEmployeeIds.push(employeeId);
              launcherState.limitMessage = launcherState.selectedEmployeeIds.length >= 10 ? '已达 10 人上限' : '';
            } else if (launcherState.selectedEmployeeIds.length >= 10) {
              this.checked = false;
              launcherState.limitMessage = '已达 10 人上限';
            }
          } else {
            launcherState.selectedEmployeeIds = launcherState.selectedEmployeeIds.filter(function (id) { return id !== employeeId; });
            launcherState.limitMessage = launcherState.selectedEmployeeIds.length < 2 ? '至少选择 2 名成员' : '';
          }
          renderLauncher();
          bindLauncherInteractions();
        });
      }
      var createButton = container.querySelector('[data-group-create-launch]');
      if (createButton && typeof createButton.addEventListener === 'function') {
        createButton.disabled = launcherState.selectedEmployeeIds.length < 2 || !stringValue(launcherState.title, '');
        createButton.addEventListener('click', function () {
          if (!stringValue(launcherState.title, '')) {
            launcherState.limitMessage = '请输入群聊标题';
            renderLauncher();
            bindLauncherInteractions();
            return;
          }
          if (launcherState.selectedEmployeeIds.length < 2) {
            launcherState.limitMessage = '至少选择 2 名成员';
            renderLauncher();
            bindLauncherInteractions();
            return;
          }
          container.lastCreateGroupHandler({
            title: launcherState.title || '新建群聊',
            member_employee_ids: launcherState.selectedEmployeeIds.slice(),
          });
        });
      }
    }

    renderLauncher();
    container.lastLoadEmployeesHandler();
  }

  // ── Modular builders for in-place switching ──

  function buildGroupState(conversation) {
    var members = listValue(conversation.members);
    var memberMap = {};
    members.forEach(function (member) {
      if (member && member.employee_id) memberMap[member.employee_id] = member;
      if (member && member.member_ref_id) memberMap[member.member_ref_id] = member;
    });

    var initialTaskItems = conversation.task_tree && Array.isArray(conversation.task_tree.items)
      ? conversation.task_tree.items.slice()
      : [];

    var persistedSenderId = '';
    try {
      persistedSenderId = stringValue(window.localStorage.getItem(GROUP_SENDER_STORAGE_KEY), '');
    } catch (_error) {
    }

    var state = {
      conversation: conversation,
      conversationId: conversation.conversation_id,
      runId: conversation.latest_run && conversation.latest_run.run_id,
      cursor: Number((conversation.timeline && conversation.timeline.latest_event_cursor) || (conversation.latest_run && conversation.latest_run.latest_event_cursor) || (conversation.last_message_preview && conversation.last_message_preview.event_cursor) || 0) || 0,
      senderId: persistedSenderId,
      members: members,
      memberMap: memberMap,
      transcriptNodes: [],
      timelineNodes: [],
      taskMap: {},
      taskOrder: [],
      seenCursors: {},
      reconnectCount: 0,
      runtimeHandle: conversation.latest_run && conversation.latest_run.runtime_handle ? conversation.latest_run.runtime_handle : null,
      currentRouteMode: (conversation.latest_route_decision && conversation.latest_route_decision.route_mode) || conversation.default_route_hint || 'auto',
      selectedMentionIds: [],
      recoveryStatus: 'idle',
      recoveryMessage: '',
      recoveryError: '',
      lastSentText: '',
      lastRouteHint: 'auto',
      memberCount: conversation.member_count || members.length || 0,
      defaultStatus: (conversation.member_count || members.length || 0) + '位成员 · ' + routeModeLabel(conversation.default_route_hint || 'auto'),
      refs: {},
    };

    initialTaskItems.forEach(function (task) {
      if (!task || !task.task_id) return;
      state.taskMap[task.task_id] = {
        id: task.task_id,
        title: stringValue(task.title, '协作任务'),
        preview: stringValue((task.output_summary && (task.output_summary.summary || task.output_summary.error_summary)) || (task.input_payload && (task.input_payload.description || task.input_payload.task_description)) || task.description, ''),
        status: stringValue(task.status, 'planned'),
        statusLabel: stringValue(task.status, 'planned'),
        employeeLabel: memberLabel(state.memberMap[task.assignee_employee_id]) || stringValue(task.assignee_employee_id, ''),
        phase: stringValue(task.input_payload && task.input_payload.phase, ''),
        parentTaskId: stringValue(task.parent_task_id, ''),
        depth: Number(task.depth) || 0,
        sequenceNo: Number(task.sequence_no) || 0,
        runtimeTaskId: stringValue(task.runtime_task_id, ''),
        routeMode: (conversation.latest_route_decision && conversation.latest_route_decision.route_mode) || 'auto',
        routeModeLabel: routeModeLabel((conversation.latest_route_decision && conversation.latest_route_decision.route_mode) || 'auto'),
        childCount: 0,
      };
      state.taskOrder.push(task.task_id);
    });
    state.taskOrder.sort(function (left, right) {
      var a = state.taskMap[left] || {};
      var b = state.taskMap[right] || {};
      if ((a.sequenceNo || 0) !== (b.sequenceNo || 0)) return (a.sequenceNo || 0) - (b.sequenceNo || 0);
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
    Object.keys(state.taskMap).forEach(function (taskId) {
      var task = state.taskMap[taskId];
      if (!task || !task.parentTaskId || !state.taskMap[task.parentTaskId]) return;
      state.taskMap[task.parentTaskId].childCount = (state.taskMap[task.parentTaskId].childCount || 0) + 1;
    });

    return state;
  }

  function buildGroupMainHtml(conversation, state) {
    return '<div class="aiteam-chatwin__header">' +
      '<div class="aiteam-chatwin__havatar" style="background:linear-gradient(135deg,#F59E0B,#F0883E)">👥</div>' +
      '<div class="aiteam-chatwin__hinfo"><div class="aiteam-chatwin__hname">' + escapeHtml(conversation.title || conversation.conversation_id || '群聊') + '</div>' +
      '<div class="aiteam-chatwin__hstatus" data-group-status>' + escapeHtml(state.defaultStatus) + '</div></div>' +
      '<div class="aiteam-chatwin__hactions">' +
      '<button class="aiteam-chatwin__tool" type="button" data-group-reconnect title="重新同步协作进度">↻</button>' +
      '<button class="aiteam-chatwin__tool" type="button" data-group-open-settings title="群设置">⚙️</button>' +
      '</div>' +
      '</div>' +
      '<div class="aiteam-chat-transcript aiteam-chatwin__transcript" data-group-transcript></div>' +
      '<div class="aiteam-chatwin__composer">' +
      '<p class="aiteam-inline-note" data-group-recovery hidden></p>' +
      '<div class="aiteam-mention-strip" data-group-mention-strip></div>' +
      '<form class="aiteam-chatwin__inputbox" data-group-form>' +
      '<textarea data-group-input rows="2" placeholder="输入群聊任务，@提及可指定员工优先回复，Enter 发送..."></textarea>' +
      '<div class="aiteam-chatwin__toolbar">' +
      '<select class="aiteam-chatwin__route" data-group-route title="协作策略"><option value="auto">自动路由</option><option value="single_agent">单员工</option><option value="orchestration">多员工协作</option></select>' +
      '<span class="aiteam-chatwin__model" data-group-mention-state hidden></span>' +
      '<span class="aiteam-chatwin__spacer"></span>' +
      '<button class="aiteam-chatwin__tool" type="button" data-group-retry title="重试上一轮">↻</button>' +
      '<button class="aiteam-chatwin__tool" type="button" data-group-abort title="停止本轮">⏹</button>' +
      '<button class="aiteam-chatwin__send" type="submit" title="发送 (Enter)">➤</button>' +
      '</div>' +
      '<input type="hidden" data-group-sender value="">' +
      '</form>' +
      '</div>';
  }

  function buildGroupRightHtml(conversation, state) {
    var memberCount = state.memberCount;
    var members = state.members;
    return '<div class="aiteam-chatwin__right-head">群聊详情</div>' +
      '<div class="aiteam-chatwin__right-body">' +
      '<div class="aiteam-agent-detail__card">' +
      renderGroupAvatarGrid(members) +
      '<div class="aiteam-agent-detail__name">' + escapeHtml(conversation.title || conversation.conversation_id || '未命名群聊') + '</div>' +
      '<div class="aiteam-agent-detail__role">👥 ' + escapeHtml(String(memberCount)) + ' 位成员 · ' + escapeHtml(routeModeLabel(conversation.default_route_hint || 'auto')) + '</div>' +
      '</div>' +
      '<div class="aiteam-detail-section"><h3>协作反馈</h3>' +
      '<div class="aiteam-route-feedback" data-group-route-feedback>' +
      '<strong data-group-route-mode>等待路由决策</strong>' +
      '<p class="aiteam-route-feedback__desc" data-group-route-desc>发送群消息后，这里会显示本轮由单员工执行还是多员工协作，以及参与成员。</p>' +
      '<div class="aiteam-route-feedback__chips" data-group-route-targets></div>' +
      '<div class="aiteam-route-feedback__chips" data-group-runtime-handle></div>' +
      '</div>' +
      '<div class="aiteam-route-feedback__chips" data-group-collab-state hidden></div>' +
      '</div>' +
      '<div class="aiteam-detail-section"><h3>任务进度</h3><ul class="aiteam-task-tree" data-group-task-tree></ul></div>' +
      '<div class="aiteam-detail-section"><h3>协作时间线</h3><div class="aiteam-timeline" data-group-timeline></div></div>' +
      '<div class="aiteam-detail-section"><h3>成员（' + escapeHtml(String(memberCount)) + '）</h3><div class="aiteam-member-list" data-group-members></div></div>' +
      '<div class="aiteam-detail-section" data-group-settings-card><h3>群设置</h3>' +
      '<div class="aiteam-detail-kv"><span>创建人</span><strong>' + escapeHtml(stringValue(conversation.owner_user_id, '未记录')) + '</strong></div>' +
      '<div class="aiteam-detail-kv"><span>创建时间</span><strong>' + escapeHtml(stringValue(conversation.created_at, '未记录')) + '</strong></div>' +
      renderLatestDecision(conversation.latest_route_decision, state) +
      renderLatestRunSummary(conversation.latest_run_summary) +
      '<div class="aiteam-group-manage">' +
      '<label class="aiteam-group-field"><span>添加员工</span><input class="aiteam-input" type="text" data-group-add-member-input placeholder="输入员工 ID"></label>' +
      '<label class="aiteam-group-field"><span>移除成员</span><select class="aiteam-input" data-group-remove-member-select>' + removableMemberOptions(members) + '</select></label>' +
      '<div class="aiteam-route-feedback__chips">' +
      '<button class="aiteam-filter-chip" type="button" data-group-add-member>新增员工</button>' +
      '<button class="aiteam-filter-chip" type="button" data-group-remove-member>踢出员工</button>' +
      '<button class="aiteam-filter-chip" type="button" data-group-archive>解散群聊</button>' +
      '</div>' +
      '</div>' +
      '<div class="aiteam-stack">' +
      '<a class="aiteam-card-link" href="/app/org"><span class="aiteam-card-link__label">成员管理</span><span class="aiteam-card-link__note">查看组织归属与团队结构</span></a>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>';
  }

  function buildGroupShellHtml(opts) {
    opts = opts || {};
    return '<section class="aiteam-page aiteam-page--chat aiteam-group-page">' +
      '<div class="aiteam-chatwin">' +
      '<aside class="aiteam-chatwin__left">' +
      '<div class="aiteam-chatwin__left-head"><span class="aiteam-chatwin__left-title">🤖 数字员工</span>' +
      '<a class="aiteam-chatwin__add" href="/app/group" title="新建群聊">＋</a></div>' +
      '<div class="aiteam-chatwin__search"><input type="search" placeholder="🔍 搜索智能体..." data-chat-agent-search></div>' +
      opts.leftHtml +
      '</aside>' +
      '<section class="aiteam-chatwin__main">' + opts.mainHtml + '</section>' +
      '<aside class="aiteam-chatwin__right aiteam-group-sidebar">' + opts.rightHtml + '</aside>' +
      '</div>' +
      '</section>';
  }

  function renderGroup(container, conversation) {
    var state = buildGroupState(conversation);
    container.innerHTML = buildGroupShellHtml({
      leftHtml: renderListSections(lastListSections, conversation.conversation_id),
      mainHtml: buildGroupMainHtml(conversation, state),
      rightHtml: buildGroupRightHtml(conversation, state),
    });
    bindListSearch(container);
    bindGroupInteractions(container, state);
    bindGroupSwitch(container);
    container.__activeGroupKey = conversation.conversation_id;
  }

  function bindGroupInteractions(container, state) {
    var conversation = state.conversation;
    var defaultStatus = state.defaultStatus;

    state.refs = {
      transcript: container.querySelector('[data-group-transcript]'),
      timeline: container.querySelector('[data-group-timeline]'),
      taskTree: container.querySelector('[data-group-task-tree]'),
      members: container.querySelector('[data-group-members]'),
      mentionStrip: container.querySelector('[data-group-mention-strip]'),
      status: container.querySelector('[data-group-status]'),
      input: container.querySelector('[data-group-input]'),
      routeSelect: container.querySelector('[data-group-route]'),
      senderInput: container.querySelector('[data-group-sender]'),
      settingsCard: container.querySelector('[data-group-settings-card]'),
      routeMode: container.querySelector('[data-group-route-mode]'),
      routeDesc: container.querySelector('[data-group-route-desc]'),
      routeTargets: container.querySelector('[data-group-route-targets]'),
      runtimeHandle: container.querySelector('[data-group-runtime-handle]'),
      mentionState: container.querySelector('[data-group-mention-state]'),
      collabState: container.querySelector('[data-group-collab-state]'),
      recovery: container.querySelector('[data-group-recovery]'),
    };

    if (state.refs.routeSelect) {
      state.refs.routeSelect.value = conversation.default_route_hint || 'auto';
    }
    if (state.refs.senderInput) {
      state.refs.senderInput.value = state.senderId;
    }

    function setStatus(text) {
      if (state.refs.status) state.refs.status.textContent = text || defaultStatus;
    }

    function setRecoveryStatus(status, message, error) {
      state.recoveryStatus = stringValue(status, 'idle');
      state.recoveryMessage = stringValue(message, '');
      state.recoveryError = stringValue(error, '');
      if (state.refs.recovery) {
        var active = state.recoveryStatus === 'reconnecting' || state.recoveryStatus === 'catching-up' || state.recoveryStatus === 'connecting' || state.recoveryStatus === 'error';
        state.refs.recovery.textContent = state.recoveryError || state.recoveryMessage || '';
        state.refs.recovery.hidden = !active || !(state.recoveryError || state.recoveryMessage);
      }
    }

    function runStatusLabel(runStatus) {
      var value = stringValue(runStatus, '');
      var map = {
        queued: '排队中',
        routing: '路由中',
        submitting: '提交中',
        running: '运行中',
        waiting_human: '等待人工',
        succeeded: '已完成',
        failed: '失败',
        cancelled: '已取消',
      };
      return map[value] || value || '未知';
    }

    function isTerminalRunStatus(runStatus) {
      var value = stringValue(runStatus, '');
      return value === 'succeeded' || value === 'failed' || value === 'cancelled';
    }

    function canAutoRecoverRun(runStatus) {
      var value = stringValue(runStatus, '');
      return !!value && !isTerminalRunStatus(value);
    }

    function getLatestRunStatus() {
      return stringValue((state.conversation.latest_run && state.conversation.latest_run.status) || '', '');
    }

    function refreshRunSummary(nextCursor) {
      if (state.conversation.latest_run) {
        state.conversation.latest_run.latest_event_cursor = Math.max(Number(state.conversation.latest_run.latest_event_cursor) || 0, Number(nextCursor) || 0);
      }
      if (state.conversation.timeline) {
        state.conversation.timeline.latest_event_cursor = Math.max(Number(state.conversation.timeline.latest_event_cursor) || 0, Number(nextCursor) || 0);
      }
    }

    function rememberSenderId(value) {
      state.senderId = stringValue(value, '');
      try {
        if (state.senderId) {
          window.localStorage.setItem(GROUP_SENDER_STORAGE_KEY, state.senderId);
        } else {
          window.localStorage.removeItem(GROUP_SENDER_STORAGE_KEY);
        }
      } catch (_error) {
      }
    }

    function selectedMentionHandles() {
      return state.selectedMentionIds.map(function (employeeId) {
        return mentionHandle(state.memberMap[employeeId] || { employee_id: employeeId, profile_name: employeeId });
      }).filter(Boolean);
    }

    function updateCollaborationState() {
      if (state.refs.mentionState) {
        var mentionHandles = selectedMentionHandles();
        if (mentionHandles.length) {
          state.refs.mentionState.textContent = collaborationModeLabel(mentionHandles.length) + ' · ' + mentionHandles.join('、');
          state.refs.mentionState.hidden = false;
        } else {
          state.refs.mentionState.textContent = '';
          state.refs.mentionState.hidden = true;
        }
      }
      if (state.refs.collabState) {
        var currentRunStatus = getLatestRunStatus();
        if (currentRunStatus) {
          state.refs.collabState.innerHTML = badge('执行状态：' + runStatusLabel(currentRunStatus));
          state.refs.collabState.hidden = false;
        } else {
          state.refs.collabState.innerHTML = '';
          state.refs.collabState.hidden = true;
        }
      }
    }

    function renderRuntimeHandle(runtimeHandle) {
      state.runtimeHandle = runtimeHandle || state.runtimeHandle;
      if (!state.refs.runtimeHandle) return;
      if (!state.runtimeHandle || !state.runtimeHandle.kind) {
        state.refs.runtimeHandle.innerHTML = '';
        return;
      }
      state.refs.runtimeHandle.innerHTML = badge(runtimeHandleLabel(state.runtimeHandle));
    }

    function renderRouteFeedback(decision, sourceRouteHint) {
      var routeMode = (decision && decision.route_mode) || sourceRouteHint || state.pendingRouteHint || state.conversation.default_route_hint || 'auto';
      var targets = listValue((decision && (decision.candidate_employee_ids || decision.target_employee_ids)) || []).map(function (employeeId) {
        return memberLabel(state.memberMap[employeeId]) || employeeId;
      });
      var planner = decision && decision.planner_employee_id ? (memberLabel(state.memberMap[decision.planner_employee_id]) || decision.planner_employee_id) : '';
      var entry = decision && decision.entry_employee_id ? (memberLabel(state.memberMap[decision.entry_employee_id]) || decision.entry_employee_id) : '';
      state.currentRouteMode = routeMode;
      if (state.refs.routeMode) state.refs.routeMode.textContent = routeModeLabel(routeMode);
      if (state.refs.routeDesc) state.refs.routeDesc.textContent = routeModeDescription(routeMode);
      if (state.refs.routeTargets) {
        var chips = [badge(routeModeLabel(routeMode))];
        if (targets.length) chips.push(badge('候选：' + targets.join('、')));
        if (entry) chips.push(badge('入口：' + entry));
        if (planner) chips.push(badge('编排：' + planner));
        state.refs.routeTargets.innerHTML = chips.join('');
      }
      updateCollaborationState();
    }

    function renderTranscript() {
      if (state.refs.transcript) {
        state.refs.transcript.innerHTML = state.transcriptNodes.join('') || '<div class="aiteam-inline-empty">等待新的群聊消息或协作结果。</div>';
      }
    }

    function renderTimeline() {
      if (state.refs.timeline) {
        state.refs.timeline.innerHTML = state.timelineNodes.join('') || '<div class="aiteam-inline-empty">协作开始后，过程记录会在这里展示。</div>';
      }
    }

    function renderTaskTree() {
      if (!state.refs.taskTree) return;
      if (!state.taskOrder.length) {
        state.refs.taskTree.innerHTML = '<li class="aiteam-task-tree__item aiteam-task-tree__item--is-auto"><div class="aiteam-task-tree__rail"></div><span class="aiteam-badge aiteam-badge--task">待命</span><div class="aiteam-task-tree__body"><strong>暂无协作任务</strong><span>多员工协作开始后，任务创建、执行与完成进度会在这里持续更新。</span></div></li>';
        return;
      }
      state.refs.taskTree.innerHTML = state.taskOrder.map(function (taskId) {
        var task = state.taskMap[taskId];
        if (!task) return '';
        return renderTaskItem(task);
      }).join('');
    }

    function renderMembers() {
      if (!state.refs.members || !state.refs.mentionStrip) return;
      if (!state.members.length) {
        state.refs.members.innerHTML = '<div class="aiteam-inline-empty">暂无群成员。</div>';
        state.refs.mentionStrip.innerHTML = '<span class="aiteam-inline-note">暂无可快捷提及成员</span>';
        return;
      }
      state.refs.members.innerHTML = state.members.map(renderMemberCard).join('');
      state.refs.mentionStrip.innerHTML = state.members.map(function (member) {
        var employeeId = member && (member.employee_id || member.member_ref_id || member.member_id) || '';
        var active = state.selectedMentionIds.indexOf(employeeId) !== -1 ? ' is-active' : '';
        return '<button class="aiteam-filter-chip' + active + '" type="button" data-mention="' + escapeHtml(mentionHandle(member)) + '" data-mention-id="' + escapeHtml(employeeId) + '">' + escapeHtml(mentionHandle(member)) + '</button>';
      }).join('');
      Array.prototype.slice.call(container.querySelectorAll('[data-mention]')).forEach(function (button) {
        button.addEventListener('click', function () {
          if (!state.refs.input) return;
          var mention = button.getAttribute('data-mention') || '';
          var employeeId = button.getAttribute('data-mention-id') || '';
          if (employeeId && state.selectedMentionIds.indexOf(employeeId) !== -1) {
            state.selectedMentionIds = state.selectedMentionIds.filter(function (id) { return id !== employeeId; });
            updateCollaborationState();
            renderMembers();
            state.refs.input.focus();
            return;
          }
          if (employeeId) {
            state.selectedMentionIds.push(employeeId);
          }
          state.refs.input.value = (state.refs.input.value || '').trim() ? state.refs.input.value + ' ' + mention + ' ' : mention + ' ';
          updateCollaborationState();
          renderMembers();
          state.refs.input.focus();
        });
      });
      updateCollaborationState();
    }

    function markSeen(event) {
      var cursor = Number(event && event.event_cursor);
      if (!Number.isFinite(cursor)) return true;
      if (state.seenCursors[cursor]) return false;
      state.seenCursors[cursor] = true;
      return true;
    }

    function appendTaskEvent(event) {
      if (!/^task_/.test(String(event && event.event_type || ''))) {
        return;
      }
      var task = normalizeTaskEvent(event || {}, state);
      var previous = state.taskMap[task.id] || {};
      if (!state.taskMap[task.id]) {
        state.taskOrder.push(task.id);
      }
      task.parentTaskId = stringValue((event && event.payload && (event.payload.parent_task_id || event.payload.parent_runtime_task_id)) || task.parentTaskId, previous.parentTaskId || '');
      task.depth = Number((event && event.payload && event.payload.depth)) || task.depth || previous.depth || 0;
      state.taskMap[task.id] = Object.assign({}, previous, task);
      Object.keys(state.taskMap).forEach(function (taskId) {
        var item = state.taskMap[taskId];
        if (item) item.childCount = 0;
      });
      Object.keys(state.taskMap).forEach(function (taskId) {
        var item = state.taskMap[taskId];
        if (!item || !item.parentTaskId || !state.taskMap[item.parentTaskId]) return;
        state.taskMap[item.parentTaskId].childCount = (state.taskMap[item.parentTaskId].childCount || 0) + 1;
      });
      state.taskOrder.sort(function (left, right) {
        var a = state.taskMap[left] || {};
        var b = state.taskMap[right] || {};
        if ((a.depth || 0) !== (b.depth || 0)) return (a.depth || 0) - (b.depth || 0);
        if ((a.sequenceNo || 0) !== (b.sequenceNo || 0)) return (a.sequenceNo || 0) - (b.sequenceNo || 0);
        return String(a.id || '').localeCompare(String(b.id || ''));
      });
      renderTaskTree();
    }

    function appendTranscriptEvent(event) {
      if (!event || !event.event_type) return;
      if (event.event_type === 'routing_decided') {
        state.transcriptNodes.push(routeDecisionMessage(event, state));
        return;
      }
      if (event.event_type === 'result_merged') {
        state.transcriptNodes.push(resultMergedMessage(event, state));
        return;
      }
      if (event.event_type === 'run_waiting_human') {
        state.transcriptNodes.push(messageBubble('system', '等待人工输入', '<p>' + escapeHtml(eventPreview(event, '当前 run 等待人工补充信息。')) + '</p>'));
        return;
      }
      if (event.event_type === 'run_failed' || event.event_type === 'error') {
        state.transcriptNodes.push(messageBubble('system', '协作异常', '<p>' + escapeHtml(eventPreview(event, '协作运行失败，请检查时间线。')) + '</p>'));
        return;
      }
      if (event.event_type === 'run_succeeded') {
        state.transcriptNodes.push(messageBubble('system', '协作完成', '<p>' + escapeHtml(eventPreview(event, '本次协作已完成。')) + '</p>'));
      }
    }

    function handleTimelineEvent(event) {
      if (!markSeen(event)) return;
      state.cursor = Math.max(state.cursor, Number(event && event.event_cursor) || 0);
      refreshRunSummary(state.cursor);
      if (event && event.event_type === 'routing_decided') {
        var decision = (event.payload && event.payload.route_decision) || {
          route_mode: event.payload && event.payload.route_mode,
          candidate_employee_ids: event.payload && event.payload.candidate_employee_ids,
          target_employee_ids: event.payload && event.payload.target_employee_ids,
          planner_employee_id: event.payload && event.payload.planner_employee_id,
          entry_employee_id: event.payload && event.payload.entry_employee_id,
        };
        state.conversation.latest_route_decision = Object.assign({}, state.conversation.latest_route_decision || {}, decision);
        renderRouteFeedback(state.conversation.latest_route_decision, decision.route_mode);
      }
      if (event && event.source_type && !state.runtimeHandle) {
        state.runtimeHandle = {
          kind: event.source_type === 'session' ? 'session' : (event.source_type === 'kanban_task' ? 'kanban_task' : event.source_type),
          session_id: event.source_type === 'session' ? event.source_id : null,
          task_id: event.source_type === 'kanban_task' ? event.source_id : null,
        };
      }
      if (event && event.event_type === 'run_waiting_human' && state.conversation.latest_run) {
        state.conversation.latest_run.status = 'waiting_human';
      } else if (event && event.event_type === 'run_failed' && state.conversation.latest_run) {
        state.conversation.latest_run.status = 'failed';
      } else if (event && event.event_type === 'run_succeeded' && state.conversation.latest_run) {
        state.conversation.latest_run.status = 'succeeded';
      } else if (event && event.event_type === 'run_cancelled' && state.conversation.latest_run) {
        state.conversation.latest_run.status = 'cancelled';
      }
      renderRuntimeHandle(state.runtimeHandle);
      state.timelineNodes.push(timelineRow(event || {}, state));
      appendTaskEvent(event || {});
      appendTranscriptEvent(event || {});
      renderTimeline();
      renderTranscript();
      updateCollaborationState();
      if (event && event.event_type === 'routing_decided') {
        setStatus('已决定协作路由，继续观察任务树与结果合并。');
      } else if (event && event.event_type === 'result_merged') {
        setStatus('结果已合并，可继续查看协作时间线。');
      } else if (event && event.event_type === 'run_failed') {
        setStatus('协作运行失败，请调整消息或协作策略后重试。');
      } else if (event && event.event_type === 'run_succeeded') {
        setStatus('协作完成。');
      }
    }

    function hydrateHistory(runId, cursor, reason) {
      setRecoveryStatus('catching-up', reason || '正在同步协作进度…');
      return ns.api.getRunEvents(runId, cursor, 100).then(function (result) {
        if (!result.ok || !result.data || !Array.isArray(result.data.items)) {
          setRecoveryStatus('error', '', result.error || '同步失败，请稍后重试。');
          return Promise.reject(new Error(result.error || 'catch-up failed'));
        }
        result.data.items.forEach(function (event) {
          handleTimelineEvent(event);
        });
        state.cursor = Math.max(state.cursor, Number(result.data.next_cursor) || state.cursor);
        refreshRunSummary(state.cursor);
        if (state.conversation.latest_run && result.data.run_status) {
          state.conversation.latest_run.status = result.data.run_status;
        }
        if (Number(result.data.latest_event_cursor) > state.cursor) {
          return hydrateHistory(runId, state.cursor, '仍有新进展，继续同步…');
        }
        if (isTerminalRunStatus(result.data.run_status)) {
          setRecoveryStatus('resolved', '已补齐断流期间事件，当前 run 已结束。');
        } else {
          setRecoveryStatus('resolved', '已补齐断流期间事件，准备恢复实时流。');
        }
        updateCollaborationState();
        return result;
      });
    }

    function handleTimelineStatus(signal) {
      var phase = stringValue(signal && signal.phase, 'idle');
      if (phase === 'connecting') {
        setRecoveryStatus('connecting', '正在连接协作进度…');
      } else if (phase === 'live') {
        setRecoveryStatus('resolved', '实时协作已恢复。');
      } else if (phase === 'reconnecting') {
        setRecoveryStatus('reconnecting', '协作流已断开，正在自动重连…');
      } else if (phase === 'catching_up') {
        setRecoveryStatus('catching-up', '连接中断，正在补齐缺失的协作进度…');
      } else if (phase === 'error') {
        setRecoveryStatus('error', '', (signal && signal.message) || '自动恢复失败，可点击 ↻ 重新同步。');
      }
      updateCollaborationState();
    }

    function syncTimeline(runId, cursor, reason) {
      if (!runId) return Promise.resolve();
      state.runId = runId;
      state.reconnectCount += 1;
      ns.timeline.disconnect();
      state.cursor = Math.max(state.cursor, Number(cursor) || 0);
      setStatus(reason || '正在同步协作进度...');
      return hydrateHistory(runId, state.cursor, reason || '正在同步协作进度…').then(function () {
        if (isTerminalRunStatus(getLatestRunStatus())) {
          setStatus('本轮协作已结束。');
          return;
        }
        ns.timeline.connect(runId, state.cursor, function (event) {
          handleTimelineEvent(event || {});
        }, {
          onOpen: function () {
            handleTimelineStatus({ phase: 'live' });
          },
          onReconnect: function (resumeCursor) {
            handleTimelineStatus({ phase: 'catching_up' });
            return hydrateHistory(runId, Number(resumeCursor) || state.cursor, '连接中断，正在补齐缺失的协作进度…').catch(function () {});
          },
        });
      }).catch(function (error) {
        setStatus((error && error.message) || '协作进度同步失败，请重试。');
      });
    }

    if (state.refs.senderInput) {
      state.refs.senderInput.addEventListener('change', function () {
        rememberSenderId(state.refs.senderInput.value);
      });
      state.refs.senderInput.addEventListener('blur', function () {
        rememberSenderId(state.refs.senderInput.value);
      });
    }

    var openSettingsBtn = container.querySelector('[data-group-open-settings]');
    if (openSettingsBtn && state.refs.settingsCard && typeof state.refs.settingsCard.scrollIntoView === 'function') {
      openSettingsBtn.addEventListener('click', function () {
        state.refs.settingsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    var form = container.querySelector('[data-group-form]');
    function resolveSenderId() {
      return stringValue(state.senderId, '')
        || (state.refs.senderInput ? stringValue(state.refs.senderInput.value, '') : '')
        || stringValue(conversation.owner_user_id, '')
        || 'owner';
    }
    if (form && state.refs.input && state.refs.routeSelect) {
      if (typeof state.refs.input.addEventListener === 'function') {
        state.refs.input.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (typeof form.requestSubmit === 'function') {
              form.requestSubmit();
            } else if (typeof form.dispatchEvent === 'function' && typeof window.Event === 'function') {
              form.dispatchEvent(new window.Event('submit', { cancelable: true }));
            }
          }
        });
      }
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var text = stringValue(state.refs.input.value, '');
        var senderId = resolveSenderId();
        if (!text) return;
        state.lastSentText = text;
        state.lastRouteHint = state.refs.routeSelect.value;
        var selectedHandles = selectedMentionHandles();
        rememberSenderId(senderId);
        state.pendingRouteHint = state.refs.routeSelect.value;
        renderRouteFeedback(null, state.refs.routeSelect.value);
        state.refs.input.value = '';
        state.transcriptNodes.push(messageBubble('user', '你', '<p>' + escapeHtml(text) + '</p><div class="aiteam-chip-row">' + badge(routeModeLabel(state.refs.routeSelect.value)) + (selectedHandles.length ? badge('提及：' + selectedHandles.join('、')) : '') + '</div>'));
        renderTranscript();
        setStatus('消息已发送，正在分配员工...');
        ns.api.submitGroupMessage(state.conversationId, {
          sender_id: senderId,
          route_hint: state.refs.routeSelect.value,
          idempotency_key: 'group-' + state.conversationId + '-' + Date.now(),
          message: { text: text },
        }).then(function (result) {
          if (!result.ok) {
            state.transcriptNodes.push(messageBubble('system', '发送失败', '<p>' + escapeHtml(result.error || '群聊消息提交失败') + '</p>'));
            renderTranscript();
            setStatus(result.error || '群聊消息提交失败');
            return;
          }
          if (result.data) {
            state.runtimeHandle = result.data.runtime_handle || state.runtimeHandle;
            state.runId = result.data.run_id || state.runId;
            state.recoveryError = '';
            if (state.conversation.latest_run) {
              state.conversation.latest_run.run_id = state.runId;
              state.conversation.latest_run.status = 'running';
              state.conversation.latest_run.runtime_handle = state.runtimeHandle;
            } else {
              state.conversation.latest_run = {
                run_id: state.runId,
                status: 'running',
                runtime_handle: state.runtimeHandle,
                latest_event_cursor: state.cursor,
              };
            }
            if (result.data.route_decision) {
              state.conversation.latest_route_decision = Object.assign({}, state.conversation.latest_route_decision || {}, result.data.route_decision);
              renderRouteFeedback(state.conversation.latest_route_decision, result.data.route_decision.route_mode);
            }
            renderRuntimeHandle(state.runtimeHandle);
            if (result.data.runtime_handle && result.data.runtime_handle.kind === 'session') {
              setStatus('本轮由单员工执行，等待回复...');
            } else if (result.data.runtime_handle && result.data.runtime_handle.kind === 'kanban_task') {
              setStatus('本轮进入多员工协作，任务正在拆解...');
            }
          }
          state.selectedMentionIds = [];
          updateCollaborationState();
          syncTimeline(result.data && result.data.run_id, state.cursor, '消息已发送，正在同步协作进度...');
        });
      });
    }

    var reconnectBtn = container.querySelector('[data-group-reconnect]');
    if (reconnectBtn) {
      reconnectBtn.addEventListener('click', function () {
        if (!state.runId) {
          setStatus('当前没有进行中的协作。');
          return;
        }
        syncTimeline(state.runId, state.cursor, '正在重新同步协作进度...');
      });
    }

    function retryLatestGroupRun() {
      if (!state.lastSentText) {
        setStatus('暂无可重试的上一条消息。');
        return;
      }
      setStatus('正在重试上一轮协作...');
      var idempotencyKey = 'group-retry-' + state.conversationId + '-' + Date.now();
      var senderId = resolveSenderId();
      ns.api.submitGroupMessage(state.conversationId, {
        sender_id: senderId,
        route_hint: state.lastRouteHint || 'auto',
        idempotency_key: idempotencyKey,
        message: { text: state.lastSentText },
      }).then(function (result) {
        if (!result.ok) {
          setStatus(result.error || '重试失败。');
          return;
        }
        ns.timeline.disconnect();
        state.liveItems = [];
        state.timelineNodes = [];
        state.taskMap = {};
        state.taskOrder = [];
        state.seenCursors = {};
        state.cursor = 0;
        state.reconnectCount = 0;
        state.transcriptNodes.push(messageBubble('user', '你', '<p>' + escapeHtml(state.lastSentText) + '</p><div class="aiteam-chip-row">' + badge(routeModeLabel(state.lastRouteHint || 'auto')) + '</div>'));
        renderTranscript();
        if (result.data) {
          state.runtimeHandle = result.data.runtime_handle || state.runtimeHandle;
          state.runId = result.data.run_id || state.runId;
          state.recoveryError = '';
          if (state.conversation.latest_run) {
            state.conversation.latest_run.run_id = state.runId;
            state.conversation.latest_run.status = 'running';
            state.conversation.latest_run.runtime_handle = state.runtimeHandle;
          } else {
            state.conversation.latest_run = {
              run_id: state.runId,
              status: 'running',
              runtime_handle: state.runtimeHandle,
              latest_event_cursor: 0,
            };
          }
        }
        var newRunId = result.data && result.data.run_id;
        setStatus('已重试，正在同步协作进度...');
        renderRuntimeHandle(state.runtimeHandle);
        syncTimeline(newRunId, 0, '已重试，正在同步协作进度...');
      });
    }

    function abortActiveGroupRun() {
      if (!state.runId) {
        setStatus('当前没有可中止的运行。');
        return;
      }
      setStatus('正在提交中止请求...');
      ns.api.abortRun(state.runId, {
        reason: '用户从群聊页主动停止本轮',
      }).then(function (result) {
        if (!result.ok) {
          setStatus(result.error || '中止失败。');
          return;
        }
        ns.timeline.disconnect();
        var alreadyTerminal = result.data && result.data.already_terminal;
        setStatus(alreadyTerminal ? '当前运行已结束，无需重复中止。' : '已提交中止请求。');
        if (state.conversation.latest_run) {
          state.conversation.latest_run.status = 'cancelled';
        }
        renderRuntimeHandle(state.runtimeHandle);
        updateCollaborationState();
      });
    }

    var retryBtn = container.querySelector('[data-group-retry]');
    var abortBtn = container.querySelector('[data-group-abort]');
    if (retryBtn) {
      retryBtn.addEventListener('click', function () {
        retryLatestGroupRun();
      });
    }
    if (abortBtn) {
      abortBtn.addEventListener('click', function () {
        abortActiveGroupRun();
      });
    }

    var addMemberBtn = container.querySelector('[data-group-add-member]');
    var addMemberInput = container.querySelector('[data-group-add-member-input]');
    if (addMemberBtn && typeof addMemberBtn.addEventListener === 'function') {
      addMemberBtn.addEventListener('click', function () {
        var employeeId = stringValue(addMemberInput && addMemberInput.value, '');
        if (!employeeId) {
          setStatus('请输入有效的 employee_id。');
          return;
        }
        container.lastAddMemberHandler({ employee_id: employeeId });
      });
    }

    var removeMemberBtn = container.querySelector('[data-group-remove-member]');
    var removeMemberSelect = container.querySelector('[data-group-remove-member-select]');
    if (removeMemberBtn && typeof removeMemberBtn.addEventListener === 'function') {
      removeMemberBtn.addEventListener('click', function () {
        var memberId = stringValue(removeMemberSelect && removeMemberSelect.value, '');
        if (!memberId) {
          setStatus('当前没有可移除的群成员。');
          return;
        }
        container.lastRemoveMemberHandler(memberId);
      });
    }

    var archiveBtn = container.querySelector('[data-group-archive]');
    if (archiveBtn && typeof archiveBtn.addEventListener === 'function') {
      archiveBtn.addEventListener('click', function () {
        container.lastArchiveGroupHandler();
      });
    }

    container.lastAddMemberHandler = function (payload) {
      if (!ns.api || !ns.api.addGroupConversationMember) {
        setStatus('当前 API client 未接入 addGroupConversationMember。');
        return Promise.resolve({ ok: false, status: 0, error: 'missing_addGroupConversationMember' });
      }
      setStatus('正在新增群成员...');
      return ns.api.addGroupConversationMember(state.conversationId, payload || {}).then(function (result) {
        if (!result.ok) {
          setStatus(result.error || '新增群成员失败');
          return result;
        }
        return ns.api.getGroupConversation(state.conversationId).then(function (detailResult) {
          if (!detailResult.ok) {
            setStatus(detailResult.error || '群成员刷新失败');
            return detailResult;
          }
          renderGroup(container, detailResult.data || {});
          return detailResult;
        });
      });
    };

    container.lastRemoveMemberHandler = function (memberId) {
      if (!ns.api || !ns.api.removeGroupConversationMember) {
        setStatus('当前 API client 未接入 removeGroupConversationMember。');
        return Promise.resolve({ ok: false, status: 0, error: 'missing_removeGroupConversationMember' });
      }
      setStatus('正在移除群成员...');
      return ns.api.removeGroupConversationMember(state.conversationId, memberId).then(function (result) {
        if (!result.ok) {
          setStatus(result.error || '移除群成员失败');
          return result;
        }
        return ns.api.getGroupConversation(state.conversationId).then(function (detailResult) {
          if (!detailResult.ok) {
            setStatus(detailResult.error || '群成员刷新失败');
            return detailResult;
          }
          renderGroup(container, detailResult.data || {});
          return detailResult;
        });
      });
    };

    container.lastArchiveGroupHandler = function () {
      if (!ns.api || !ns.api.archiveGroupConversation) {
        setStatus('当前 API client 未接入 archiveGroupConversation。');
        return Promise.resolve({ ok: false, status: 0, error: 'missing_archiveGroupConversation' });
      }
      setStatus('正在解散群聊...');
      return ns.api.archiveGroupConversation(state.conversationId).then(function (result) {
        if (!result.ok) {
          setStatus(result.error || '解散群聊失败');
          return result;
        }
        state.conversation.status = (result.data && result.data.status) || 'archived';
        setStatus('群聊已解散。');
        updateCollaborationState();
        return result;
      });
    };

    renderMembers();
    renderRouteFeedback(conversation.latest_route_decision, conversation.default_route_hint);
    renderRuntimeHandle(state.runtimeHandle);
    renderTranscript();
    renderTimeline();
    renderTaskTree();
    setRecoveryStatus('idle', '');
    updateCollaborationState();
    setStatus('');

    if (state.runId) {
      syncTimeline(state.runId, state.cursor, '正在恢复最近一次协作进度...');
    }
  }

  // ── In-place group switching (mirrors app-chat.js pattern) ──

  function swapGroupView(container, conversation) {
    var main = container.querySelector ? container.querySelector('.aiteam-chatwin__main') : null;
    var right = container.querySelector ? container.querySelector('.aiteam-chatwin__right') : null;
    if (!main || !right) {
      renderGroup(container, conversation);
      return;
    }
    var state = buildGroupState(conversation);
    main.innerHTML = buildGroupMainHtml(conversation, state);
    right.innerHTML = buildGroupRightHtml(conversation, state);
    bindGroupInteractions(container, state);
    container.__activeGroupKey = conversation.conversation_id;
  }

  function applyGroupActiveByPath(container, path) {
    if (!container || !container.querySelectorAll) return;
    var items = container.querySelectorAll('.aiteam-chat__agent');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var isMatch = item && item.getAttribute && item.getAttribute('href') === path;
      if (item && item.classList) {
        if (isMatch) item.classList.add('is-active'); else item.classList.remove('is-active');
      }
      if (isMatch && item.querySelector) {
        var badgeEl = item.querySelector('.aiteam-chat__agent-unread');
        if (badgeEl && badgeEl.parentNode) badgeEl.parentNode.removeChild(badgeEl);
      }
    }
  }

  function navigateToGroupPath(container, path) {
    if (ns.timeline && typeof ns.timeline.disconnect === 'function') ns.timeline.disconnect();
    applyGroupActiveByPath(container, path);
    var conversationId = getConversationId(path);
    if (!conversationId) {
      renderGroupLauncher(container);
      return;
    }
    ns.api.getGroupConversation(conversationId).then(function (result) {
      if (!result || !result.ok) {
        if (typeof window !== 'undefined' && window.location && typeof window.location.assign === 'function') window.location.assign(path);
        return;
      }
      var conv = result.data || {};
      swapGroupView(container, conv);
      if (ns.api && typeof ns.api.updateWorkbenchState === 'function' && conv.conversation_id) {
        ns.api.updateWorkbenchState({ conversation_id: conv.conversation_id, mark_read: true });
        markConversationReadInSections(lastListSections, conv.conversation_id);
      }
    }).catch(function () {
      if (typeof window !== 'undefined' && window.location && typeof window.location.assign === 'function') window.location.assign(path);
    });
  }

  function switchGroupConversation(container, path) {
    var conversationId = getConversationId(path);
    var currentKey = (container && container.__activeGroupKey) || getConversationId(window.location.pathname);
    if (conversationId && conversationId === currentKey) return;
    if (typeof window !== 'undefined' && window.history && typeof window.history.pushState === 'function') {
      window.history.pushState(null, '', path);
    }
    navigateToGroupPath(container, path);
  }

  function bindGroupSwitch(container) {
    if (!container || typeof container.addEventListener !== 'function') return;
    if (!container.__groupSwitchBound) {
      container.__groupSwitchBound = true;
      container.addEventListener('click', function (event) {
        if (event.defaultPrevented) return;
        if (event.button !== undefined && event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        var anchor = event.target && event.target.closest ? event.target.closest('a.aiteam-chat__agent[data-chat-group]') : null;
        if (!anchor) return;
        var href = anchor.getAttribute ? anchor.getAttribute('href') : '';
        if (!href || href.indexOf('/app/group/') !== 0) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        switchGroupConversation(container, href);
      });
    }
    if (!ns.__groupPopstateBound && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      ns.__groupPopstateBound = true;
      window.addEventListener('popstate', function () {
        var main = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('aiteam-main') : null;
        if (!main) return;
        var path = (window.location && window.location.pathname) || '';
        if (path.indexOf('/app/group') !== 0) return;
        navigateToGroupPath(main, path);
      });
    }
  }
  ns.pages.appGroup = {
    render: renderGroup,
    init: function (container, options) {
      if (!container) return;
      var conversationId = getConversationId(options && options.pathname);
      if (!conversationId) {
        renderGroupLauncher(container);
        return;
      }
      if (container.classList && container.classList.add) {
        container.classList.add('aiteam-main--flush');
      }
      ns.states.renderLoading(container, '加载群聊会话...');
      ns.api.getGroupConversation(conversationId).then(function (result) {
        if (!result.ok) {
          ns.states.handleApiResult(result, container, function () {});
          return;
        }
        var conv = result.data || {};
        if (ns.api && typeof ns.api.getWorkbench === 'function') {
          ns.api.getWorkbench().then(function (wb) {
            var sections = mapWorkbenchToListSections((wb && wb.ok && wb.data) ? wb.data : {});
            syncOpenedConversationRead(conv.conversation_id, sections, function (synced) {
              lastListSections = synced || sections;
              renderGroup(container, conv);
            });
          }).catch(function () { renderGroup(container, conv); });
        } else {
          renderGroup(container, conv);
        }
      });
    },
    _switchGroupConversation: switchGroupConversation,
    _navigateToGroupPath: navigateToGroupPath,
    _swapGroupView: swapGroupView,
    _buildGroupState: buildGroupState,
    _buildGroupMainHtml: buildGroupMainHtml,
    _buildGroupRightHtml: buildGroupRightHtml,
    _buildGroupShellHtml: buildGroupShellHtml,
    _bindGroupInteractions: bindGroupInteractions,
    _bindGroupSwitch: bindGroupSwitch,
    _applyGroupActiveByPath: applyGroupActiveByPath,
  };
}(window.aiteam));
