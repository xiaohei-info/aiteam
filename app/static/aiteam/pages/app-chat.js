window.aiteam = window.aiteam || {};

(function registerChatPage(ns) {
  ns.pages = ns.pages || {};
  var escapeHtml = (ns.util && ns.util.escapeHtml) || function (value) { return String(value == null ? '' : value); };

  function getConversationId(pathname) {
    var parts = String(pathname || window.location.pathname || '').split('/');
    return parts.length >= 4 ? decodeURIComponent(parts[3]) : '';
  }

  function messageBubble(role, title, body, extraClass) {
    return '<article class="aiteam-message aiteam-message--' + role + (extraClass ? ' ' + extraClass : '') + '">' +
      '<div class="aiteam-message__meta">' + escapeHtml(title) + '</div>' +
      '<div class="aiteam-message__body">' + body + '</div>' +
      '</article>';
  }

  function renderToolCall(payload) {
    var toolName = payload.tool_name || payload.tool || 'tool_call';
    var summary = payload.preview || payload.summary || '工具调用已触发';
    return '<div class="aiteam-tool-card"><div class="aiteam-tool-card__title">工具调用 · ' + escapeHtml(toolName) + '</div>' +
      '<pre class="aiteam-tool-card__body">' + escapeHtml(summary) + '</pre></div>';
  }

  function quoteBlock(preview) {
    if (!preview) {
      return '';
    }
    return '<blockquote class="aiteam-quote">' + escapeHtml(preview) + '</blockquote>';
  }

  function eventToNode(event) {
    if (!event || !event.event_type) {
      return '';
    }
    if (event.event_type === 'tool_call') {
      return messageBubble('assistant', '工具执行', renderToolCall(event.payload || event), 'aiteam-message--tool');
    }
    if (event.event_type === 'message_delta') {
      return messageBubble('assistant', '员工回复', escapeHtml((event.payload && event.payload.text) || event.preview || '正在输出内容...'));
    }
    if (event.event_type === 'run_failed') {
      return messageBubble('system', '运行失败', escapeHtml(event.preview || '本次运行失败，可重试发送。'));
    }
    if (event.event_type === 'run_succeeded') {
      return messageBubble('system', '运行完成', escapeHtml(event.preview || '本次回复已完成。'));
    }
    return '<div class="aiteam-timeline-row"><span>' + escapeHtml(event.event_type) + '</span><strong>' + escapeHtml(event.preview || '已记录') + '</strong></div>';
  }

  function appendTimeline(nodes, event) {
    nodes.push(eventToNode(event));
    return nodes;
  }

  function bindChat(container, state) {
    var form = container.querySelector('[data-chat-form]');
    var input = container.querySelector('[data-chat-input]');
    var quoteBtn = container.querySelector('[data-chat-quote]');
    var retryBtn = container.querySelector('[data-chat-retry]');
    var abortBtn = container.querySelector('[data-chat-abort]');
    var attachBtn = container.querySelector('[data-chat-attach]');
    var statusEl = container.querySelector('[data-chat-status]');
    var transcript = container.querySelector('[data-chat-transcript]');

    function setStatus(text) {
      if (statusEl) statusEl.textContent = text || '';
    }

    function renderTranscript() {
      transcript.innerHTML = state.nodes.join('');
    }

    function syncRun(runId, initialCursor) {
      if (!runId) {
        return;
      }
      state.runId = runId;
      state.cursor = Number(initialCursor) || state.cursor || 0;
      setStatus('queued / 正在唤起员工...');
      ns.timeline.connect(runId, state.cursor, function (event) {
        appendTimeline(state.nodes, event || {});
        state.cursor = ns.timeline.getCurrentCursor();
        renderTranscript();
        if (event && (event.event_type === 'run_succeeded' || event.event_type === 'run_failed')) {
          setStatus(event.event_type === 'run_failed' ? '本次运行失败，可使用“重试发送”。' : '回复完成。');
        }
      });
      ns.api.getRunEvents(runId, state.cursor, 100).then(function (result) {
        if (!result.ok || !result.data || !Array.isArray(result.data.items)) {
          return;
        }
        result.data.items.forEach(function (event) {
          appendTimeline(state.nodes, event);
          state.cursor = Math.max(state.cursor, Number(event.event_cursor) || 0);
        });
        renderTranscript();
      });
    }

    function createRun(messageText) {
      state.lastSentText = messageText;
      state.nodes.push(messageBubble('user', '你', quoteBlock(state.lastMessagePreview) + '<p>' + escapeHtml(messageText) + '</p>'));
      renderTranscript();
      setStatus('创建运行中...');
      ns.api.createRun({
        employee_id: state.employeeId,
        conversation_id: state.conversationId,
        message_text: messageText,
        idempotency_key: 'chat-' + state.conversationId + '-' + messageText,
      }).then(function (result) {
        if (!result.ok) {
          state.nodes.push(messageBubble('system', '发送失败', escapeHtml(result.error || '消息发送失败，可重试。')));
          renderTranscript();
          setStatus('发送失败，可重试发送。');
          return;
        }
        syncRun(result.data && result.data.run_id, state.cursor);
      });
    }

    if (form && input) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var text = String(input.value || '').trim();
        if (!text) return;
        input.value = '';
        createRun(text);
      });
    }

    if (quoteBtn && input) {
      quoteBtn.addEventListener('click', function () {
        var preview = state.lastMessagePreview || '引用上一条会话内容';
        input.value = '> ' + preview + '\n\n' + input.value;
        input.focus();
      });
    }

    if (retryBtn) {
      retryBtn.addEventListener('click', function () {
        if (!state.lastSentText) return;
        createRun(state.lastSentText);
      });
    }

    if (abortBtn) {
      abortBtn.addEventListener('click', function () {
        setStatus('当前北向契约未提供取消接口，已停止前端补拉并保留现场。');
        ns.timeline.disconnect();
      });
    }

    if (attachBtn) {
      attachBtn.addEventListener('click', function () {
        setStatus('正在登记附件元数据...');
        ns.api.upload({ name: 'meeting-notes.txt', size: 128, mime_type: 'text/plain' }).then(function (result) {
          setStatus(result.ok ? '附件已登记，可随下一次发送提交。' : (result.error || '附件登记失败。'));
        });
      });
    }
  }

  function renderChat(container, conversation) {
    var preview = conversation.last_message_preview && conversation.last_message_preview.preview;
    var state = {
      conversationId: conversation.conversation_id,
      employeeId: conversation.employee_ref && conversation.employee_ref.employee_id,
      runId: conversation.latest_run && conversation.latest_run.run_id,
      cursor: conversation.last_message_preview && conversation.last_message_preview.event_cursor || 0,
      lastMessagePreview: preview || '',
      lastSentText: '',
      nodes: [
        messageBubble('system', '员工欢迎语', '<p>欢迎开始新的私聊任务。</p><div class="aiteam-chip-row"><span class="aiteam-tag">总结知识库</span><span class="aiteam-tag">起草回复</span><span class="aiteam-tag">整理待办</span></div>'),
      ],
    };
    if (preview) {
      state.nodes.push(messageBubble('assistant', '历史摘要', '<p>' + escapeHtml(preview) + '</p>'));
    }

    container.innerHTML = '<section class="aiteam-page aiteam-page--chat">' +
      '<div class="aiteam-page__hero"><div><p class="aiteam-page__eyebrow">P05 · 单聊对话</p><h2 class="aiteam-page__title">会话 ' + escapeHtml(conversation.conversation_id) + '</h2>' +
      '<p class="aiteam-page__desc">通过 Team Panel 会话详情、runs 和 timeline SSE 组合还原单聊体验。</p></div>' +
      '<div class="aiteam-hero-actions"><a class="aiteam-button aiteam-button--ghost" href="/admin/employees">配置员工</a></div></div>' +
      '<div class="aiteam-grid aiteam-grid--chat">' +
      '<section class="aiteam-panel"><div class="aiteam-panel__header"><h3>消息区</h3><span data-chat-status class="aiteam-inline-note">display_state：' + escapeHtml(conversation.display_state || 'idle') + '</span></div>' +
      '<div class="aiteam-chat-transcript" data-chat-transcript></div>' +
      '<form class="aiteam-chat-composer" data-chat-form><textarea data-chat-input placeholder="输入要交给员工处理的任务"></textarea><div class="aiteam-action-row">' +
      '<button class="aiteam-button aiteam-button--ghost" type="button" data-chat-quote>引用历史</button>' +
      '<button class="aiteam-button aiteam-button--ghost" type="button" data-chat-attach>登记附件</button>' +
      '<button class="aiteam-button aiteam-button--ghost" type="button" data-chat-retry>重试发送</button>' +
      '<button class="aiteam-button aiteam-button--ghost" type="button" data-chat-abort>停止补拉</button>' +
      '<button class="aiteam-button" type="submit">发送</button>' +
      '</div></form></section>' +
      '<aside class="aiteam-panel"><div class="aiteam-panel__header"><h3>员工摘要</h3><a href="/admin/employees">后台详情</a></div>' +
      '<div class="aiteam-detail-kv"><span>员工 ID</span><strong>' + escapeHtml(state.employeeId || '未绑定') + '</strong></div>' +
      '<div class="aiteam-detail-kv"><span>最新 run</span><strong>' + escapeHtml(state.runId || '暂无') + '</strong></div>' +
      '<div class="aiteam-detail-kv"><span>消息引用</span><strong>支持一键将历史摘要插入输入框</strong></div>' +
      '<p class="aiteam-inline-note">当前契约未提供 abort/cancel 北向接口，因此“停止补拉”只会断开前端 SSE 并保留已回放过程。</p>' +
      '</aside>' +
      '</div>' +
      '</section>';

    bindChat(container, state);
    var transcript = container.querySelector('[data-chat-transcript]');
    if (transcript) {
      transcript.innerHTML = state.nodes.join('');
    }
    if (state.runId) {
      ns.api.getRunEvents(state.runId, 0, 100).then(function (result) {
        if (!result.ok || !result.data || !Array.isArray(result.data.items)) {
          return;
        }
        result.data.items.forEach(function (event) {
          state.nodes.push(eventToNode(event));
        });
        transcript.innerHTML = state.nodes.join('');
      });
      ns.timeline.connect(state.runId, state.cursor, function (event) {
        state.nodes.push(eventToNode(event || {}));
        state.cursor = ns.timeline.getCurrentCursor();
        transcript.innerHTML = state.nodes.join('');
      });
    }
  }

  ns.pages.appChat = {
    render: renderChat,
    init: function (container, options) {
      if (!container) return;
      var conversationId = getConversationId(options && options.pathname);
      if (!conversationId) {
        ns.states.renderError(container, '缺少会话 ID，无法打开单聊页。');
        return;
      }
      ns.states.renderLoading(container, '加载单聊会话...');
      ns.api.getConversation(conversationId).then(function (result) {
        if (!result.ok) {
          ns.states.handleApiResult(result, container, function () {});
          return;
        }
        renderChat(container, result.data || {});
      });
    },
  };
}(window.aiteam));
