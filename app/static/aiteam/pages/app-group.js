window.aiteam = window.aiteam || {};

(function registerGroupPage(ns) {
  ns.pages = ns.pages || {};
  var escapeHtml = (ns.util && ns.util.escapeHtml) || function (value) { return String(value == null ? '' : value); };

  function getConversationId(pathname) {
    var parts = String(pathname || window.location.pathname || '').split('/');
    return parts.length >= 4 ? decodeURIComponent(parts[3]) : '';
  }

  function timelineRow(event) {
    var preview = (event && (event.preview || (event.payload && event.payload.text))) || '已记录';
    var type = event && event.event_type ? event.event_type : 'timeline';
    return '<div class="aiteam-timeline-row"><span>' + escapeHtml(type) + '</span><strong>' + escapeHtml(preview) + '</strong></div>';
  }

  function taskTreeNode(event) {
    var preview = (event && (event.preview || (event.payload && event.payload.text))) || '任务更新';
    return '<li><span class="aiteam-badge">' + escapeHtml(event.event_type || 'event') + '</span><span>' + escapeHtml(preview) + '</span></li>';
  }

  function renderGroup(container, conversation) {
    var state = {
      conversationId: conversation.conversation_id,
      runId: conversation.latest_run && conversation.latest_run.run_id,
      cursor: conversation.last_message_preview && conversation.last_message_preview.event_cursor || 0,
      items: [],
      taskItems: [],
      senderId: 'user_demo',
    };

    container.innerHTML = '<section class="aiteam-page aiteam-page--chat">' +
      '<div class="aiteam-page__hero"><div><p class="aiteam-page__eyebrow">P06 · 群聊协作</p><h2 class="aiteam-page__title">群聊 ' + escapeHtml(conversation.conversation_id) + '</h2>' +
      '<p class="aiteam-page__desc">成员管理、@提及入口、协作时间线与任务树统一在群聊页呈现。</p></div>' +
      '<div class="aiteam-hero-actions"><span class="aiteam-badge">' + escapeHtml(conversation.display_state || 'idle') + '</span></div></div>' +
      '<div class="aiteam-grid aiteam-grid--chat">' +
      '<section class="aiteam-panel"><div class="aiteam-panel__header"><h3>协作消息</h3><span class="aiteam-inline-note" data-group-status>等待发送群聊消息</span></div>' +
      '<div class="aiteam-mention-strip"><button class="aiteam-filter-chip" type="button" data-mention="@Orion">@Orion</button><button class="aiteam-filter-chip" type="button" data-mention="@Planner">@Planner</button><button class="aiteam-filter-chip" type="button" data-mention="@Finance">@Finance</button></div>' +
      '<form class="aiteam-chat-composer" data-group-form><textarea data-group-input placeholder="输入群聊任务，可使用 @提及触发单/多智能体路由"></textarea><div class="aiteam-action-row">' +
      '<select class="aiteam-select" data-group-route><option value="auto">自动路由</option><option value="single_agent">单员工</option><option value="orchestration">多员工协作</option></select>' +
      '<button class="aiteam-button aiteam-button--ghost" type="button" data-group-reconnect>重新补拉</button>' +
      '<button class="aiteam-button" type="submit">发送群聊消息</button>' +
      '</div></form>' +
      '<div class="aiteam-panel aiteam-panel--nested"><div class="aiteam-panel__header"><h3>协作时间线</h3><a href="/app/workbench">返回工作台</a></div><div class="aiteam-timeline" data-group-timeline></div></div>' +
      '</section>' +
      '<aside class="aiteam-panel"><div class="aiteam-panel__header"><h3>成员与任务树</h3><a href="/app/org">组织结构</a></div>' +
      '<div class="aiteam-member-list"><div class="aiteam-member"><strong>成员面板</strong><span>当前契约未返回成员清单，使用 @提及快捷入口 + sender_id 发送。</span></div><div class="aiteam-member"><strong>默认协作策略</strong><span>由 route_hint 和后端 route_decision 共同决定。</span></div></div>' +
      '<div class="aiteam-panel aiteam-panel--nested"><div class="aiteam-panel__header"><h3>任务树</h3><span class="aiteam-inline-note">task_created / task_started / task_completed</span></div><ul class="aiteam-task-tree" data-group-task-tree></ul></div>' +
      '</aside></div></section>';

    var timelineEl = container.querySelector('[data-group-timeline]');
    var taskTreeEl = container.querySelector('[data-group-task-tree]');
    var statusEl = container.querySelector('[data-group-status]');
    var input = container.querySelector('[data-group-input]');
    var routeSelect = container.querySelector('[data-group-route]');

    function setStatus(text) {
      if (statusEl) statusEl.textContent = text || '';
    }

    function syncTimeline(runId, cursor) {
      if (!runId) return;
      state.runId = runId;
      state.cursor = Number(cursor) || 0;
      setStatus('连接协作时间线中...');
      ns.timeline.connect(runId, state.cursor, function (event) {
        state.items.push(timelineRow(event || {}));
        if (event && /^task_/.test(event.event_type || '')) {
          state.taskItems.push(taskTreeNode(event));
        }
        if (event && event.event_type === 'routing_decided') {
          setStatus('已决定协作路由，继续观察任务树进展。');
        }
        if (event && event.event_type === 'result_merged') {
          setStatus('结果已合并，可继续追踪后续收尾事件。');
        }
        if (event && event.event_type === 'run_failed') {
          setStatus('协作运行失败，请调整路由方式后重试。');
        }
        if (timelineEl) timelineEl.innerHTML = state.items.join('');
        if (taskTreeEl) taskTreeEl.innerHTML = state.taskItems.join('');
      });
      ns.api.getRunEvents(runId, state.cursor, 100).then(function (result) {
        if (!result.ok || !result.data || !Array.isArray(result.data.items)) {
          return;
        }
        result.data.items.forEach(function (event) {
          state.items.push(timelineRow(event));
          if (/^task_/.test(event.event_type || '')) {
            state.taskItems.push(taskTreeNode(event));
          }
          state.cursor = Math.max(state.cursor, Number(event.event_cursor) || 0);
        });
        if (timelineEl) timelineEl.innerHTML = state.items.join('');
        if (taskTreeEl) taskTreeEl.innerHTML = state.taskItems.join('');
      });
    }

    Array.prototype.slice.call(container.querySelectorAll('[data-mention]')).forEach(function (button) {
      button.addEventListener('click', function () {
        if (!input) return;
        input.value = (input.value || '').trim() ? input.value + ' ' + button.getAttribute('data-mention') + ' ' : button.getAttribute('data-mention') + ' ';
        input.focus();
      });
    });

    var form = container.querySelector('[data-group-form]');
    if (form && input && routeSelect) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var text = String(input.value || '').trim();
        if (!text) return;
        input.value = '';
        setStatus('群聊消息已提交，等待 route_decision...');
        ns.api.submitGroupMessage(state.conversationId, {
          sender_id: state.senderId,
          route_hint: routeSelect.value,
          idempotency_key: 'group-' + state.conversationId + '-' + text,
          message: { text: text },
        }).then(function (result) {
          if (!result.ok) {
            setStatus(result.error || '群聊消息提交失败');
            return;
          }
          state.items.push('<div class="aiteam-timeline-row"><span>message_submitted</span><strong>' + escapeHtml(text) + '</strong></div>');
          if (timelineEl) timelineEl.innerHTML = state.items.join('');
          syncTimeline(result.data && result.data.run_id, state.cursor);
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
        setStatus('正在执行 SSE 断流补拉...');
        syncTimeline(state.runId, state.cursor);
      });
    }

    if (state.runId) {
      syncTimeline(state.runId, state.cursor);
    }
  }

  ns.pages.appGroup = {
    render: renderGroup,
    init: function (container, options) {
      if (!container) return;
      var conversationId = getConversationId(options && options.pathname);
      if (!conversationId) {
        ns.states.renderError(container, '缺少群聊会话 ID，无法打开协作页。');
        return;
      }
      ns.states.renderLoading(container, '加载群聊会话...');
      ns.api.getConversation(conversationId).then(function (result) {
        if (!result.ok) {
          ns.states.handleApiResult(result, container, function () {});
          return;
        }
        renderGroup(container, result.data || {});
      });
    },
  };
}(window.aiteam));
