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
      auto: '由 Team Panel 根据消息内容、@提及与成员能力决定单员工或多员工协作。',
      single_agent: '本轮消息会优先路由到单个数字员工，不展开任务树协作。',
      orchestration: '本轮消息会进入协作编排，由多个数字员工拆解任务并合并结果。',
    };
    return map[String(mode || 'auto')] || '等待新的 route_decision。';
  }

  function routeModeClass(mode) {
    var value = String(mode || 'auto');
    return value === 'orchestration' ? 'is-multi' : (value === 'single_agent' ? 'is-single' : 'is-auto');
  }

  function runtimeHandleLabel(runtimeHandle) {
    if (!runtimeHandle || !runtimeHandle.kind) return '等待 run 句柄';
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
    var actor = memberLabel(state.memberMap[event.employee_id]) || stringValue(event.employee_id, '系统');
    var routeMode = payload.route_mode || (payload.route_decision && payload.route_decision.route_mode) || (state.conversation.latest_route_decision && state.conversation.latest_route_decision.route_mode) || 'auto';
    var meta = [eventTypeLabel(event.event_type || 'timeline')];
    if (event.event_cursor != null) meta.push('#' + String(event.event_cursor));
    if (event.employee_id) meta.push(actor);
    if (event.source_id) meta.push(String(event.source_id));
    if (/^task_/.test(String(event.event_type || ''))) {
      meta.push(routeModeLabel(routeMode));
    }
    return '<div class="aiteam-timeline-row aiteam-timeline-row--' + escapeHtml(String(event.event_type || 'timeline')) + '">' +
      '<div class="aiteam-timeline-row__top">' +
      '<span class="aiteam-timeline-row__pill aiteam-timeline-row__pill--' + routeModeClass(routeMode) + '">' + escapeHtml(eventTypeLabel(event.event_type || 'timeline')) + '</span>' +
      '<span class="aiteam-timeline-row__cursor">cursor ' + escapeHtml(String(event.event_cursor != null ? event.event_cursor : '-')) + '</span>' +
      '</div>' +
      '<strong>' + escapeHtml(eventPreview(event, '已记录')) + '</strong>' +
      '<div class="aiteam-timeline-row__meta">' + escapeHtml(meta.join(' · ')) + '</div>' +
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
    var runtimeText = task.runtimeTaskId ? '<span class="aiteam-task-tree__runtime">runtime: ' + escapeHtml(task.runtimeTaskId) + '</span>' : '';
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

  function renderMemberCard(member) {
    var handle = mentionHandle(member);
    var extra = member.is_human ? '会话成员' : '可被 @提及';
    return '<article class="aiteam-member" data-member-id="' + escapeHtml(member.member_id || member.employee_id || '') + '">' +
      '<div class="aiteam-member__header">' +
      '<div><strong>' + escapeHtml(memberLabel(member)) + '</strong><span>' + escapeHtml(memberRole(member)) + '</span></div>' +
      badge(memberStatus(member)) +
      '</div>' +
      '<div class="aiteam-member__meta">' +
      '<span>' + escapeHtml(handle) + '</span>' +
      '<span>' + escapeHtml(extra) + '</span>' +
      '</div>' +
      '<div class="aiteam-action-row">' +
      '<button class="aiteam-filter-chip" type="button" data-mention="' + escapeHtml(handle) + '">插入提及</button>' +
      (member.employee_id ? '<a class="aiteam-card-link aiteam-card-link--inline" href="/admin/employees/' + encodeURIComponent(member.employee_id) + '"><span class="aiteam-card-link__label">成员详情</span><span class="aiteam-card-link__note">后台配置入口</span></a>' : '') +
      '</div>' +
      '</article>';
  }

  function renderGroupAvatarGrid(members) {
    var previewMembers = listValue(members).slice(0, 4);
    if (!previewMembers.length) {
      return '<div class="aiteam-inline-empty">当前群聊 contract 没有返回可展示成员。</div>';
    }
    return '<div class="aiteam-group-avatar-grid" aria-label="群聊头像 2×2 宫格">' + previewMembers.map(function (member) {
      var initial = memberLabel(member).slice(0, 1) || '?';
      return '<div class="aiteam-group-avatar-grid__cell"><strong>' + escapeHtml(initial) + '</strong><span>' + escapeHtml(memberLabel(member)) + '</span></div>';
    }).join('') + '</div>';
  }

  function renderLatestDecision(decision, state) {
    if (!decision) {
      return '<div class="aiteam-card"><div class="aiteam-card__row"><strong>最近协作决策</strong>' + badge('暂无') + '</div><p class="aiteam-card__sub">还没有 route_decision，首条群聊消息提交后会出现协作方式与候选成员。</p></div>';
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

  function renderGroupLauncher(container) {
    var launcherState = {
      title: '新建群聊',
      employeeItems: [],
      selectedEmployeeIds: ['emp_test', 'emp_member'],
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
      '<p class="aiteam-page__eyebrow">P06 · 群聊协作</p>' +
      '<h2 class="aiteam-page__title">新建群聊</h2>' +
      '<p class="aiteam-page__desc">创建群聊后即可进入群成员栏、@提及、协作时间线与任务树视图。</p>' +
      '</div>' +
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
          launcherState.limitMessage = launcherState.selectedEmployeeIds.length < 2 ? '至少选择 2 名成员' : '';
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

  function renderGroup(container, conversation) {
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

    var initialRunStatus = conversation.latest_run && conversation.latest_run.status;
    var heroBadges = [
      badge(conversation.display_state || 'idle'),
      badge((conversation.member_count || members.length || 0) + ' 位成员'),
      badge(routeModeLabel(conversation.default_route_hint || 'auto')),
      badge(initialRunStatus || '暂无 run'),
    ].join('');

    container.innerHTML = '<section class="aiteam-page aiteam-page--chat aiteam-group-page">' +
      '<div class="aiteam-page__hero">' +
      '<div>' +
      '<p class="aiteam-page__eyebrow">P06 · 群聊协作</p>' +
      '<h2 class="aiteam-page__title">' + escapeHtml(conversation.title || conversation.conversation_id || '群聊') + '</h2>' +
      '<p class="aiteam-page__desc">群成员栏、@输入、协作时间线、任务树/协作气泡与群设置入口统一在同一页呈现；所有读取都基于 Team Panel group conversation / run timeline contract。</p>' +
      '</div>' +
      '<div class="aiteam-hero-actions">' + heroBadges +
      '<a class="aiteam-button" href="/app/group">新建群聊</a>' +
      '<button type="button" class="aiteam-button aiteam-button--ghost" data-group-open-settings>群设置</button>' +
      '<a class="aiteam-button aiteam-button--ghost" href="/app/org">成员管理</a>' +
      '</div>' +
      '</div>' +
      '<div class="aiteam-grid aiteam-grid--chat aiteam-group-layout">' +
      '<section class="aiteam-panel">' +
      '<div class="aiteam-panel__header"><h3>会话区</h3><span class="aiteam-inline-note" data-group-status>加载群聊 contract...</span></div>' +
      '<div class="aiteam-card aiteam-card--flat">' +
      '<div class="aiteam-card__row"><strong>SSE 恢复状态</strong><span class="aiteam-inline-note" data-group-recovery-label>idle</span></div>' +
      '<p class="aiteam-card__sub" data-group-recovery>实时流稳定后会在这里显示 reconnecting / catching-up / resolved / error。</p>' +
      '</div>' +
      '<div class="aiteam-chat-transcript" data-group-transcript></div>' +
      '<div class="aiteam-panel aiteam-panel--nested">' +
      '<div class="aiteam-panel__header"><h3>@ 提及与发送</h3><span class="aiteam-inline-note">sender_id / route_hint / message.text</span></div>' +
      '<div class="aiteam-mention-strip" data-group-mention-strip></div>' +
      '<div class="aiteam-route-feedback" data-group-route-feedback>' +
      '<div class="aiteam-route-feedback__summary">' +
      '<span class="aiteam-route-feedback__label">协作反馈</span>' +
      '<strong data-group-route-mode>等待路由决策</strong>' +
      '</div>' +
      '<p class="aiteam-route-feedback__desc" data-group-route-desc>提交群消息后会显示本轮是单员工执行还是多员工协作，以及候选成员。</p>' +
      '<div class="aiteam-route-feedback__chips" data-group-route-targets></div>' +
      '<div class="aiteam-route-feedback__chips" data-group-runtime-handle></div>' +
      '</div>' +
      '<div class="aiteam-card aiteam-card--flat">' +
      '<div class="aiteam-card__row"><strong>提及选择 / 协作状态</strong><span class="aiteam-inline-note" data-group-collab-state>display_state / run_status / cursor</span></div>' +
      '<div class="aiteam-route-feedback__chips" data-group-mention-state></div>' +
      '</div>' +
      '<form class="aiteam-chat-composer" data-group-form>' +
      '<textarea data-group-input placeholder="输入群聊任务，可使用 @提及触发指定员工优先回复"></textarea>' +
      '<div class="aiteam-group-controls">' +
      '<label class="aiteam-group-field"><span>发送者 ID</span><input type="text" data-group-sender placeholder="填写当前会话成员 user_id / actor_id"></label>' +
      '<label class="aiteam-group-field"><span>协作策略</span><select class="aiteam-select" data-group-route><option value="auto">自动路由</option><option value="single_agent">单员工</option><option value="orchestration">多员工协作</option></select></label>' +
      '</div>' +
      '<div class="aiteam-action-row">' +
      '<button class="aiteam-button aiteam-button--ghost" type="button" data-group-reconnect>重新补拉</button>' +
      '<button class="aiteam-button" type="submit">发送群聊消息</button>' +
      '</div>' +
      '<p class="aiteam-inline-note">当前 northbound contract 仍要求显式传入 sender_id；成员增删/解散群聊的正式写接口尚未开放，因此这里提供群设置入口和成员管理跳转，不伪造未实现写语义。</p>' +
      '</form>' +
      '</div>' +
      '<div class="aiteam-panel aiteam-panel--nested">' +
      '<div class="aiteam-panel__header"><h3>协作时间线</h3><span class="aiteam-inline-note">routing_decided / task_* / result_merged</span></div>' +
      '<div class="aiteam-timeline" data-group-timeline></div>' +
      '</div>' +
      '</section>' +
      '<aside class="aiteam-panel aiteam-group-sidebar">' +
      '<div class="aiteam-panel__header"><h3>群信息与成员栏</h3><a href="/app/workbench">返回工作台</a></div>' +
      '<div class="aiteam-panel aiteam-panel--nested"><div class="aiteam-panel__header"><h3>群聊头像</h3><span class="aiteam-inline-note">前 4 名成员 · 2×2 宫格</span></div>' + renderGroupAvatarGrid(members) + '</div>' +
      '<div class="aiteam-detail-kv"><span>群聊名称</span><strong>' + escapeHtml(conversation.title || conversation.conversation_id || '未命名群聊') + '</strong></div>' +
      '<div class="aiteam-detail-kv"><span>群聊 ID</span><strong>' + escapeHtml(conversation.conversation_id || '未知') + '</strong></div>' +
      '<div class="aiteam-detail-kv"><span>创建人</span><strong>' + escapeHtml(stringValue(conversation.owner_user_id, '未记录')) + '</strong></div>' +
      '<div class="aiteam-detail-kv"><span>创建时间</span><strong>' + escapeHtml(stringValue(conversation.created_at, '未记录')) + '</strong></div>' +
      '<div class="aiteam-detail-kv"><span>默认协作策略</span><strong>' + escapeHtml(routeModeLabel(conversation.default_route_hint || 'auto')) + '</strong></div>' +
      '<div class="aiteam-detail-kv"><span>最近运行状态</span><strong>' + escapeHtml(initialRunStatus || '暂无') + '</strong></div>' +
      '<div class="aiteam-panel aiteam-panel--nested" data-group-settings-card>' +
      '<div class="aiteam-panel__header"><h3>群设置</h3><span class="aiteam-inline-note">当前可见 contract</span></div>' +
      renderLatestDecision(conversation.latest_route_decision, state) +
      '<div class="aiteam-stack">' +
      '<a class="aiteam-card-link" href="/app/org"><span class="aiteam-card-link__label">成员管理入口</span><span class="aiteam-card-link__note">通过组织架构页查看归属与调整团队结构</span></a>' +
      '<a class="aiteam-card-link" href="/admin/employees"><span class="aiteam-card-link__label">群设置配套入口</span><span class="aiteam-card-link__note">前往员工后台核对角色、模型与技能配置</span></a>' +
      '</div>' +
      '<div class="aiteam-route-feedback__chips">' +
      '<button class="aiteam-filter-chip" type="button" data-group-add-member>新增员工</button>' +
      '<button class="aiteam-filter-chip" type="button" data-group-remove-member>踢出员工</button>' +
      '<button class="aiteam-filter-chip" type="button" data-group-archive>解散群聊</button>' +
      '</div>' +
      '<p class="aiteam-inline-note">成员管理动作现已通过 Team Panel northbound API 落地；若需要批量调整，仍可配合组织架构页与员工后台使用。</p>' +
      '</div>' +
      '<div class="aiteam-panel aiteam-panel--nested"><div class="aiteam-panel__header"><h3>成员栏</h3><span class="aiteam-inline-note">' + escapeHtml(String(conversation.member_count || members.length || 0)) + ' 名成员</span></div><div class="aiteam-member-list" data-group-members></div></div>' +
      '<div class="aiteam-panel aiteam-panel--nested"><div class="aiteam-panel__header"><h3>任务树 / 协作区</h3><span class="aiteam-inline-note">显示父子任务、执行成员与 runtime task 句柄</span></div><ul class="aiteam-task-tree" data-group-task-tree></ul></div>' +
      '</aside>' +
      '</div>' +
      '</section>';

    var transcriptEl = container.querySelector('[data-group-transcript]');
    var timelineEl = container.querySelector('[data-group-timeline]');
    var taskTreeEl = container.querySelector('[data-group-task-tree]');
    var membersEl = container.querySelector('[data-group-members]');
    var mentionStripEl = container.querySelector('[data-group-mention-strip]');
    var statusEl = container.querySelector('[data-group-status]');
    var input = container.querySelector('[data-group-input]');
    var routeSelect = container.querySelector('[data-group-route]');
    var senderInput = container.querySelector('[data-group-sender]');
    var settingsCard = container.querySelector('[data-group-settings-card]');
    var routeModeEl = container.querySelector('[data-group-route-mode]');
    var routeDescEl = container.querySelector('[data-group-route-desc]');
    var routeTargetsEl = container.querySelector('[data-group-route-targets]');
    var runtimeHandleEl = container.querySelector('[data-group-runtime-handle]');
    var mentionStateEl = container.querySelector('[data-group-mention-state]');
    var collabStateEl = container.querySelector('[data-group-collab-state]');
    var recoveryLabelEl = container.querySelector('[data-group-recovery-label]');
    var recoveryEl = container.querySelector('[data-group-recovery]');

    if (routeSelect) {
      routeSelect.value = conversation.default_route_hint || 'auto';
    }
    if (senderInput) {
      senderInput.value = state.senderId;
    }

    function setStatus(text) {
      if (statusEl) statusEl.textContent = text || '';
    }

    function setRecoveryStatus(status, message, error) {
      state.recoveryStatus = stringValue(status, 'idle');
      state.recoveryMessage = stringValue(message, '');
      state.recoveryError = stringValue(error, '');
      if (recoveryLabelEl) recoveryLabelEl.textContent = state.recoveryStatus;
      if (recoveryEl) {
        recoveryEl.textContent = state.recoveryError || state.recoveryMessage || '实时流稳定后会在这里显示 reconnecting / catching-up / resolved / error。';
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
      if (mentionStateEl) {
        var mentionHandles = selectedMentionHandles();
        var chips = [badge(collaborationModeLabel(mentionHandles.length))];
        if (mentionHandles.length) chips.push(badge('已选：' + mentionHandles.join('、')));
        chips.push(badge('display_state：' + stringValue(state.conversation.display_state, 'idle')));
        chips.push(badge('恢复：' + state.recoveryStatus));
        mentionStateEl.innerHTML = chips.join('');
      }
      if (collabStateEl) {
        var currentRunStatus = getLatestRunStatus();
        collabStateEl.textContent = 'display_state：' + stringValue(state.conversation.display_state, 'idle') + ' · run：' + runStatusLabel(currentRunStatus || '暂无 run') + ' · cursor：' + String(state.cursor || 0);
      }
    }

    function renderRuntimeHandle(runtimeHandle) {
      state.runtimeHandle = runtimeHandle || state.runtimeHandle;
      if (!runtimeHandleEl) return;
      if (!state.runtimeHandle || !state.runtimeHandle.kind) {
        runtimeHandleEl.innerHTML = '<span class="aiteam-inline-note">等待本轮 run 返回 runtime_handle。</span>';
        return;
      }
      var chips = [badge(runtimeHandleLabel(state.runtimeHandle))];
      if (state.runtimeHandle.session_id) chips.push(badge('session_id: ' + state.runtimeHandle.session_id));
      if (state.runtimeHandle.task_id) chips.push(badge('task_id: ' + state.runtimeHandle.task_id));
      if (state.runtimeHandle.profile_name) chips.push(badge('profile: ' + state.runtimeHandle.profile_name));
      runtimeHandleEl.innerHTML = chips.join('');
    }

    function renderRouteFeedback(decision, sourceRouteHint) {
      var routeMode = (decision && decision.route_mode) || sourceRouteHint || state.pendingRouteHint || state.conversation.default_route_hint || 'auto';
      var targets = listValue((decision && (decision.candidate_employee_ids || decision.target_employee_ids)) || []).map(function (employeeId) {
        return memberLabel(state.memberMap[employeeId]) || employeeId;
      });
      var planner = decision && decision.planner_employee_id ? (memberLabel(state.memberMap[decision.planner_employee_id]) || decision.planner_employee_id) : '';
      var entry = decision && decision.entry_employee_id ? (memberLabel(state.memberMap[decision.entry_employee_id]) || decision.entry_employee_id) : '';
      state.currentRouteMode = routeMode;
      if (routeModeEl) routeModeEl.textContent = routeModeLabel(routeMode);
      if (routeDescEl) routeDescEl.textContent = routeModeDescription(routeMode);
      if (routeTargetsEl) {
        var chips = [badge(routeModeLabel(routeMode))];
        if (targets.length) chips.push(badge('候选：' + targets.join('、')));
        if (entry) chips.push(badge('入口：' + entry));
        if (planner) chips.push(badge('编排：' + planner));
        routeTargetsEl.innerHTML = chips.join('');
      }
      updateCollaborationState();
    }

    function renderTranscript() {
      if (transcriptEl) {
        transcriptEl.innerHTML = state.transcriptNodes.join('') || '<div class="aiteam-inline-empty">等待新的群聊消息或协作结果。</div>';
      }
    }

    function renderTimeline() {
      if (timelineEl) {
        timelineEl.innerHTML = state.timelineNodes.join('') || '<div class="aiteam-inline-empty">协作时间线会在 routing_decided 与 task_* 事件到达后出现。</div>';
      }
    }

    function renderTaskTree() {
      if (!taskTreeEl) return;
      if (!state.taskOrder.length) {
        taskTreeEl.innerHTML = '<li class="aiteam-task-tree__item aiteam-task-tree__item--is-auto"><div class="aiteam-task-tree__rail"></div><span class="aiteam-badge aiteam-badge--task">待命</span><div class="aiteam-task-tree__body"><strong>任务树已就绪</strong><span>task_created / task_started / task_completed 会在这里持续更新，单员工路径会保持轻量模式。</span></div></li>';
        return;
      }
      taskTreeEl.innerHTML = state.taskOrder.map(function (taskId) {
        var task = state.taskMap[taskId];
        if (!task) return '';
        return renderTaskItem(task);
      }).join('');
    }

    function renderMembers() {
      if (!membersEl || !mentionStripEl) return;
      if (!state.members.length) {
        membersEl.innerHTML = '<div class="aiteam-inline-empty">当前群聊 contract 没有返回成员列表。</div>';
        mentionStripEl.innerHTML = '<span class="aiteam-inline-note">暂无可快捷提及成员</span>';
        return;
      }
      membersEl.innerHTML = state.members.map(renderMemberCard).join('');
      mentionStripEl.innerHTML = state.members.map(function (member) {
        var employeeId = member && (member.employee_id || member.member_ref_id || member.member_id) || '';
        return '<button class="aiteam-filter-chip" type="button" data-mention="' + escapeHtml(mentionHandle(member)) + '" data-mention-id="' + escapeHtml(employeeId) + '">' + escapeHtml(mentionHandle(member)) + '</button>';
      }).join('');
      Array.prototype.slice.call(container.querySelectorAll('[data-mention]')).forEach(function (button) {
        button.addEventListener('click', function () {
          if (!input) return;
          var mention = button.getAttribute('data-mention') || '';
          var employeeId = button.getAttribute('data-mention-id') || '';
          if (employeeId && state.selectedMentionIds.indexOf(employeeId) === -1) {
            state.selectedMentionIds.push(employeeId);
          }
          input.value = (input.value || '').trim() ? input.value + ' ' + mention + ' ' : mention + ' ';
          updateCollaborationState();
          input.focus();
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
      setRecoveryStatus('catching-up', reason || '正在补拉断流期间遗漏的协作事件…');
      return ns.api.getRunEvents(runId, cursor, 100).then(function (result) {
        if (!result.ok || !result.data || !Array.isArray(result.data.items)) {
          setRecoveryStatus('error', '', result.error || '补拉失败，请稍后重试。');
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
          return hydrateHistory(runId, state.cursor, '检测到后端仍有新事件，继续 catch-up…');
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
        setRecoveryStatus('connecting', '正在建立协作 SSE 连接…');
      } else if (phase === 'live') {
        setRecoveryStatus('resolved', '实时协作流已恢复，不会重复补拉已消费事件。');
      } else if (phase === 'reconnecting') {
        setRecoveryStatus('reconnecting', '协作流已断开，正在自动重连…');
      } else if (phase === 'catching_up') {
        setRecoveryStatus('catching-up', 'SSE 已断流，正在 catch-up 缺失事件…');
      } else if (phase === 'error') {
        setRecoveryStatus('error', '', (signal && signal.message) || '自动恢复失败，可手动重新补拉。');
      }
      updateCollaborationState();
    }

    function syncTimeline(runId, cursor, reason) {
      if (!runId) return Promise.resolve();
      state.runId = runId;
      state.reconnectCount += 1;
      ns.timeline.disconnect();
      state.cursor = Math.max(state.cursor, Number(cursor) || 0);
      ns.timeline.setCurrentCursor(state.cursor);
      setStatus(reason || '连接协作时间线中...');
      return hydrateHistory(runId, state.cursor, reason || '正在补拉协作时间线…').then(function () {
        if (isTerminalRunStatus(getLatestRunStatus())) {
          setStatus('已补齐终态 run 的事件，无需保持 SSE 实时连接。');
          return;
        }
        ns.timeline.connect(runId, state.cursor, {
          onEvent: function (event) {
            handleTimelineEvent(event || {});
          },
          onStatus: handleTimelineStatus,
          onReconnect: function (info) {
            return hydrateHistory(runId, Number(info && info.cursor) || state.cursor, 'SSE 断流，正在 catch-up 缺失事件…').then(function () {
              return { cursor: state.cursor };
            });
          },
        });
      }).catch(function (error) {
        setStatus((error && error.message) || '协作时间线恢复失败，请重试。');
      });
    }

    if (senderInput) {
      senderInput.addEventListener('change', function () {
        rememberSenderId(senderInput.value);
      });
      senderInput.addEventListener('blur', function () {
        rememberSenderId(senderInput.value);
      });
    }

    var openSettingsBtn = container.querySelector('[data-group-open-settings]');
    if (openSettingsBtn && settingsCard && typeof settingsCard.scrollIntoView === 'function') {
      openSettingsBtn.addEventListener('click', function () {
        settingsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    var form = container.querySelector('[data-group-form]');
    if (form && input && routeSelect) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var text = stringValue(input.value, '');
        var senderId = senderInput ? stringValue(senderInput.value, '') : state.senderId;
        if (!text) return;
        if (!senderId) {
          setStatus('请先填写 sender_id（当前会话成员 user_id / actor_id）。');
          if (senderInput) senderInput.focus();
          return;
        }
        var selectedHandles = selectedMentionHandles();
        rememberSenderId(senderId);
        state.pendingRouteHint = routeSelect.value;
        renderRouteFeedback(null, routeSelect.value);
        input.value = '';
        state.transcriptNodes.push(messageBubble('user', '你', '<p>' + escapeHtml(text) + '</p><div class="aiteam-chip-row">' + badge(routeModeLabel(routeSelect.value)) + badge('sender_id: ' + senderId) + (selectedHandles.length ? badge('提及：' + selectedHandles.join('、')) : '') + '</div>'));
        renderTranscript();
        setStatus('群聊消息已提交，等待 route_decision...');
        ns.api.submitGroupMessage(state.conversationId, {
          sender_id: senderId,
          route_hint: routeSelect.value,
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
              setStatus('已命中单员工路径，等待 session 时间线结果。');
            } else if (result.data.runtime_handle && result.data.runtime_handle.kind === 'kanban_task') {
              setStatus('已进入多员工协作，等待任务树展开。');
            }
          }
          state.selectedMentionIds = [];
          updateCollaborationState();
          syncTimeline(result.data && result.data.run_id, state.cursor, '消息已提交，开始同步协作时间线...');
        });
      });
    }

    var reconnectBtn = container.querySelector('[data-group-reconnect]');
    if (reconnectBtn) {
      reconnectBtn.addEventListener('click', function () {
        if (!state.runId) {
          setStatus('当前没有可补拉的 run。');
          return;
        }
        syncTimeline(state.runId, state.cursor, '正在执行 SSE 断流补拉...');
      });
    }

    var addMemberBtn = container.querySelector('[data-group-add-member]');
    if (addMemberBtn && typeof addMemberBtn.addEventListener === 'function') {
      addMemberBtn.addEventListener('click', function () {
        var typed = typeof window.prompt === 'function'
          ? window.prompt('请输入要加入群聊的 employee_id', '')
          : '';
        if (typed == null) return;
        var employeeId = stringValue(typed, '');
        if (!employeeId) {
          setStatus('请输入有效的 employee_id。');
          return;
        }
        container.lastAddMemberHandler({ employee_id: employeeId });
      });
    }

    var removeMemberBtn = container.querySelector('[data-group-remove-member]');
    if (removeMemberBtn && typeof removeMemberBtn.addEventListener === 'function') {
      removeMemberBtn.addEventListener('click', function () {
        var removable = state.members.filter(function (member) { return stringValue(member.member_id, ''); });
        if (!removable.length) {
          setStatus('当前没有可移除的群成员。');
          return;
        }
        var candidate = removable[removable.length - 1];
        container.lastRemoveMemberHandler(candidate.member_id);
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
    setRecoveryStatus('idle', '实时流稳定后会在这里显示 reconnecting / catching-up / resolved / error。');
    updateCollaborationState();
    setStatus('display_state：' + stringValue(conversation.display_state, 'idle'));

    if (state.runId) {
      syncTimeline(state.runId, state.cursor, '恢复最近一次协作 run 的时间线...');
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
      ns.states.renderLoading(container, '加载群聊会话...');
      ns.api.getGroupConversation(conversationId).then(function (result) {
        if (!result.ok) {
          ns.states.handleApiResult(result, container, function () {});
          return;
        }
        renderGroup(container, result.data || {});
      });
    },
  };
}(window.aiteam));
