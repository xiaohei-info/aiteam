window.aiteam = window.aiteam || {};

(function registerChatPage(ns) {
  ns.pages = ns.pages || {};
  var escapeHtml = (ns.util && ns.util.escapeHtml) || function (value) { return String(value == null ? '' : value); };

  function getConversationId(pathname) {
    var parts = String(pathname || window.location.pathname || '').split('/');
    return parts.length >= 4 ? decodeURIComponent(parts[3]) : '';
  }

  function formatTime(value) {
    if (!value) {
      return '刚刚';
    }
    try {
      var date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return String(value);
      }
      return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (_error) {
      return String(value);
    }
  }

  function chip(label, tone) {
    return '<span class="aiteam-chat-chip' + (tone ? ' aiteam-chat-chip--' + tone : '') + '">' + escapeHtml(label) + '</span>';
  }

  function renderQuote(quote) {
    if (!quote || !quote.preview) {
      return '';
    }
    return '<blockquote class="aiteam-quote">引用：' + escapeHtml(quote.preview) + '</blockquote>';
  }

  function renderAttachmentList(attachments) {
    if (!Array.isArray(attachments) || !attachments.length) {
      return '';
    }
    return '<div class="aiteam-chat-attachments">' + attachments.map(function (item) {
      item = item || {};
      var label = item.name || item.file_name || item.filename || item.url || item.asset_id || '附件';
      var meta = [item.kind || item.scope, item.mime_type, item.size != null ? (item.size + ' B') : ''].filter(Boolean).join(' · ');
      var href = item.preview_url || item.url || item.download_url || '';
      return '<article class="aiteam-chat-attachment">' +
        '<div class="aiteam-chat-attachment__icon">📎</div>' +
        '<div class="aiteam-chat-attachment__body"><strong>' + escapeHtml(label) + '</strong>' + (meta ? '<span>' + escapeHtml(meta) + '</span>' : '') + '</div>' +
        (href ? '<a class="aiteam-chat-attachment__link" href="' + escapeHtml(href) + '" target="_blank" rel="noreferrer">预览</a>' : '<span class="aiteam-chat-attachment__link is-disabled">待桥接</span>') +
        '</article>';
    }).join('') + '</div>';
  }

  function normalizeToolStatus(payload) {
    if (payload.is_error) {
      return { label: '失败', tone: 'danger' };
    }
    if (payload.done || payload.finished || payload.status === 'done' || payload.status === 'completed' || payload.status === 'succeeded') {
      return { label: '已完成', tone: 'success' };
    }
    if (payload.status === 'running' || payload.status === 'pending' || payload.status === 'started') {
      return { label: '执行中', tone: 'brand' };
    }
    return { label: '已触发', tone: 'neutral' };
  }

  function summarizeToolArgs(payload) {
    var raw = payload.arguments || payload.args || payload.input || payload.parameters || payload.params;
    if (raw == null || raw === '') {
      return '';
    }
    try {
      return typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
    } catch (_error) {
      return String(raw);
    }
  }

  function summarizeToolResult(payload) {
    var raw = payload.result || payload.output || payload.response || payload.preview || payload.summary || payload.text || payload.snippet;
    if (raw == null || raw === '') {
      return '';
    }
    try {
      return typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
    } catch (_error) {
      return String(raw);
    }
  }

  function renderCitationList(citations) {
    if (!Array.isArray(citations) || !citations.length) {
      return '';
    }
    return '<div class="aiteam-chat-citations">' + citations.map(function (item) {
      var label = item.title || item.label || item.url || '引用来源';
      return '<span class="aiteam-chat-citation">' + escapeHtml(label) + '</span>';
    }).join('') + '</div>';
  }

  function renderMetadataBlock(metadata) {
    if (!metadata || typeof metadata !== 'object') {
      return '';
    }
    var bits = [];
    if (metadata.summary) {
      bits.push('<div class="aiteam-inline-note">摘要：' + escapeHtml(metadata.summary) + '</div>');
    }
    if (metadata.error_summary) {
      bits.push('<div class="aiteam-inline-note">失败说明：' + escapeHtml(metadata.error_summary) + '</div>');
    }
    if (metadata.cancel_summary) {
      bits.push('<div class="aiteam-inline-note">取消说明：' + escapeHtml(metadata.cancel_summary) + '</div>');
    }
    if (metadata.usage && typeof metadata.usage === 'object') {
      var usage = metadata.usage;
      var usageBits = [];
      if (usage.total_tokens != null) usageBits.push('tokens ' + usage.total_tokens);
      if (usage.prompt_tokens != null) usageBits.push('prompt ' + usage.prompt_tokens);
      if (usage.completion_tokens != null) usageBits.push('completion ' + usage.completion_tokens);
      if (usage.cost_cents != null) usageBits.push('¥' + (Number(usage.cost_cents) / 100).toFixed(2));
      if (usageBits.length) {
        bits.push('<div class="aiteam-inline-note">用量：' + escapeHtml(usageBits.join(' · ')) + '</div>');
      }
    }
    return bits.join('');
  }

  function messageTitle(message) {
    if (!message) {
      return '消息';
    }
    if (message.role === 'user') {
      return '你';
    }
    if (message.role === 'assistant') {
      return '员工';
    }
    return '系统提示';
  }

  function messageSpeakerName(message, employeeSummary, conversation) {
    if (!message) return '系统';
    if (message.role === 'user') {
      return '你';
    }
    if (message.role === 'assistant') {
      return (employeeSummary && employeeSummary.display_name)
        || (conversation && conversation.employee_ref && conversation.employee_ref.display_name)
        || message.sender_id
        || '员工回复';
    }
    return message.sender_id || '系统';
  }

  function messageMeta(title, speakerName) {
    var speaker = speakerName || title || '系统';
    var initial = speaker.slice(0, 1) || '?';
    return '<div class="aiteam-message__speaker"><span class="aiteam-message__avatar">' + escapeHtml(initial) + '</span><span class="aiteam-message__speaker-name">' + escapeHtml(speaker) + '</span></div>' +
      '<span class="aiteam-message__kind">' + escapeHtml(title || '消息') + '</span>';
  }

  function renderMessageBubble(message, extraClass, employeeSummary, conversation) {
    var roleClass = message && message.role ? message.role : 'system';
    var body = '';
    body += renderQuote(message && message.quote);
    body += message && message.text ? '<p>' + escapeHtml(message.text).replace(/\n/g, '<br>') + '</p>' : '<p>暂无正文</p>';
    body += renderAttachmentList(message && message.attachments);
    body += renderCitationList(message && message.citations);
    body += renderMetadataBlock(message && message.metadata);
    var title = messageTitle(message);
    var speakerName = messageSpeakerName(message, employeeSummary, conversation);
    return '<article class="aiteam-message aiteam-message--' + roleClass + (extraClass ? ' ' + extraClass : '') + '">' +
      '<div class="aiteam-message__meta">' +
      messageMeta(title, speakerName) +
      '<span>' + escapeHtml(formatTime(message && message.created_at)) + '</span>' +
      '</div>' +
      '<div class="aiteam-message__body">' + body + '</div>' +
      '</article>';
  }

  function renderThinking() {
    return '<div class="aiteam-chat__thinking"><div class="aiteam-chat__thinking-dots">' +
      '<span class="aiteam-chat__thinking-dot"></span><span class="aiteam-chat__thinking-dot"></span><span class="aiteam-chat__thinking-dot"></span>' +
      '</div>正在思考中...</div>';
  }

  function renderTimelineItem(item) {
    item = item || {};
    var t = String(item.type || item.kind || '').toLowerCase();
    if (t === 'tool_call' || t === 'tool') {
      var name = item.tool_name || item.name || 'tool';
      var args = item.tool_args != null ? item.tool_args : (item.args != null ? item.args : '');
      var result = item.tool_result != null ? item.tool_result : '';
      var statusLabel = item.status_label || '';
      return '<div class="aiteam-chat__tool-card"><div class="aiteam-chat__tool-head">⚡ 调用工具' +
        (statusLabel ? ' · ' + escapeHtml(String(statusLabel)) : '') + '</div>' +
        '<div class="aiteam-chat__tool-call">' + escapeHtml(String(name)) + '(' + escapeHtml(String(args)) + ')</div>' +
        (result ? '<pre class="aiteam-chat__tool-result">' + escapeHtml(String(result)) + '</pre>' : '') +
        '</div>';
    }
    if (t === 'loop' || t === 'orchestration') {
      var steps = (item.steps || []).map(function (s) {
        var cls = s.status === 'done' ? ' is-done' : (s.status === 'running' ? ' is-running' : '');
        var label = s.status === 'done' ? '✓ 完成' : (s.status === 'running' ? '● 进行中' : '○ 等待');
        return '<div class="aiteam-chat__loop-step' + cls + '">' + escapeHtml(s.title || '') +
          '<span class="aiteam-chat__loop-step-status">' + label + '</span></div>';
      }).join('');
      return '<div class="aiteam-chat__loop-card"><div class="aiteam-chat__loop-title">🦞 龙虾编排</div>' + steps + '</div>';
    }
    return '';
  }

  function renderTimelineNotice(event) {
    var eventType = event && event.event_type;
    var labels = {
      run_created: '运行已创建',
      routing_decided: '路由已决定',
      run_started: '开始执行',
      run_waiting_human: '等待人工输入',
      heartbeat: '执行心跳',
      error: '过程告警',
      run_failed: '运行失败',
      run_cancelled: '已中止',
      run_succeeded: '运行完成'
    };
    var label = labels[eventType] || '时间线事件';
    var preview = event && event.preview ? event.preview : '';
    if (!preview) {
      if (eventType === 'run_failed') preview = '本次运行失败，可重试发送。';
      else if (eventType === 'run_cancelled') preview = '本次运行已取消。';
      else if (eventType === 'run_succeeded') preview = '本次回复已完成。';
      else if (eventType === 'routing_decided') preview = '系统正在决定由哪位员工继续处理。';
      else if (eventType === 'run_started') preview = '员工已开始处理本轮任务。';
      else if (eventType === 'run_waiting_human') preview = '当前运行等待人工补充信息后继续。';
      else if (eventType === 'heartbeat') preview = '运行仍在进行中。';
      else if (eventType === 'error') preview = '时间线记录到过程异常。';
      else preview = '已记录过程事件。';
    }
    return '<div class="aiteam-timeline-row"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(preview) + '</strong></div>';
  }

  function historyItem(message, activeId) {
    var subtitleBits = [];
    subtitleBits.push(message.role === 'user' ? '用户提问' : (message.role === 'assistant' ? '员工回复' : '系统记录'));
    if (message.citations && message.citations.length) {
      subtitleBits.push('引用 ' + message.citations.length);
    }
    if (message.attachments && message.attachments.length) {
      subtitleBits.push('附件 ' + message.attachments.length);
    }
    return '<button class="aiteam-history-item' + (activeId === message.message_id ? ' is-active' : '') + '" type="button" data-history-message="' + escapeHtml(message.message_id) + '">' +
      '<span class="aiteam-history-item__title">' + escapeHtml(message.text || '空消息') + '</span>' +
      '<span class="aiteam-history-item__meta">' + escapeHtml(subtitleBits.join(' · ')) + '</span>' +
      '<span class="aiteam-history-item__time">' + escapeHtml(formatTime(message.created_at)) + '</span>' +
      '</button>';
  }

  // 右栏「智能体详情」— 对齐 Demo：员工卡片 / 运行统计 / 技能标签 / 记忆片段 / 使用模型。
  function renderSummaryPanel(summary, conversation) {
    summary = summary || {};
    conversation = conversation || {};
    if (!summary || (!summary.display_name && !summary.employee_id)) {
      return '<div class="aiteam-inline-empty">选择一个会话后，这里会展示该数字员工的详情。</div>';
    }
    var usage = summary.usage_summary || {};
    var statusCounts = usage.status_counts || {};
    var completed = statusCounts.succeeded != null ? statusCounts.succeeded : null;
    var totalRuns = usage.total_runs != null ? usage.total_runs : null;
    var successRate = (totalRuns && completed != null) ? Math.round((completed / totalRuns) * 100) + '%' : '—';
    var avgResponse = usage.avg_response_seconds != null ? (usage.avg_response_seconds + 's') : '—';
    var modelLine = [summary.model_provider, summary.model_name].filter(Boolean).join(' · ') || '未配置';
    var monthlyTokens = usage.total_tokens != null ? String(usage.total_tokens) : '—';
    var monthlyCost = usage.total_cost_cents != null ? ('¥ ' + (Number(usage.total_cost_cents) / 100).toFixed(2)) : '—';
    var initial = (summary.display_name || summary.employee_id || 'A').slice(0, 1);
    var skills = Array.isArray(summary.skills) ? summary.skills : [];
    var kbs = Array.isArray(summary.knowledge_bases) ? summary.knowledge_bases : [];
    var memories = Array.isArray(summary.memories) ? summary.memories : (Array.isArray(summary.memory_snippets) ? summary.memory_snippets : []);
    return '<div class="aiteam-chat-summary">' +
      '<div class="aiteam-agent-detail__card">' +
      '<div class="aiteam-agent-detail__avatar">' + escapeHtml(initial) + '</div>' +
      '<div class="aiteam-agent-detail__name">' + escapeHtml(summary.display_name || summary.employee_id || '未命名员工') + '</div>' +
      '<div class="aiteam-agent-detail__role">🎯 ' + escapeHtml(summary.role_name || '待配置岗位') + '</div>' +
      '</div>' +
      '<div class="aiteam-detail-section"><h3>运行统计</h3>' +
      '<div class="aiteam-chat-stat-grid">' +
      '<article class="aiteam-chat-stat"><strong class="is-green">' + escapeHtml(String(completed != null ? completed : '—')) + '</strong><span>完成任务</span></article>' +
      '<article class="aiteam-chat-stat"><strong class="is-brand">' + escapeHtml(successRate) + '</strong><span>成功率</span></article>' +
      '<article class="aiteam-chat-stat"><strong class="is-purple">' + escapeHtml(avgResponse) + '</strong><span>平均响应</span></article>' +
      '</div></div>' +
      '<div class="aiteam-detail-section"><h3>技能标签</h3>' +
      (skills.length ? '<div class="aiteam-chip-row">' + skills.map(function (s) { return chip(typeof s === 'string' ? s : (s.name || ''), 'neutral'); }).join('') + '</div>' : '<div class="aiteam-inline-empty">暂无技能绑定</div>') +
      '</div>' +
      '<div class="aiteam-detail-section"><h3>记忆片段</h3>' +
      (memories.length ? memories.map(function (m) {
        var text = typeof m === 'string' ? m : (m.text || m.summary || '');
        return '<div class="aiteam-mem-item"><span class="aiteam-mem-item__icon">💡</span><span>' + escapeHtml(text) + '</span></div>';
      }).join('') : '<div class="aiteam-inline-empty">暂无记忆片段</div>') +
      '</div>' +
      '<div class="aiteam-detail-section"><h3>知识库</h3>' +
      (kbs.length ? '<div class="aiteam-chip-row">' + kbs.map(function (k) { return chip(typeof k === 'string' ? k : (k.name || ''), 'neutral'); }).join('') + '</div>' : '<div class="aiteam-inline-empty">暂无知识库绑定</div>') +
      '</div>' +
      '<div class="aiteam-detail-section"><h3>使用模型</h3>' +
      '<div class="aiteam-agent-detail__model"><span class="aiteam-agent-detail__model-dot"></span>' + escapeHtml(modelLine) + '</div>' +
      '<div class="aiteam-agent-detail__model-meta">本月消耗：' + escapeHtml(monthlyTokens) + ' Tokens<br>费用：' + escapeHtml(monthlyCost) + '<br>最近运行：' + escapeHtml(formatTime(usage.last_run_at || conversation.created_at)) + '</div>' +
      '</div>' +
      '<div class="aiteam-detail-section"><a class="aiteam-card-link" href="/admin/employees/' + encodeURIComponent(summary.employee_id || '') + '"><span class="aiteam-card-link__label">配置员工</span><span class="aiteam-card-link__note">技能 / 知识 / 模型 / 记忆</span></a></div>' +
      '</div>';
  }

  function buildConversationRequestPath(conversationId, cursor, limit) {
    return '/conversations/' + encodeURIComponent(conversationId) + '?cursor=' + Number(cursor || 0) + '&limit=' + Number(limit || 100);
  }

  function bindChat(container, state) {
    state.refs = {
      history: container.querySelector('[data-chat-history]'),
      transcript: container.querySelector('[data-chat-transcript]'),
      status: container.querySelector('[data-chat-status]'),
      quoteBanner: container.querySelector('[data-chat-quote-banner]'),
      pendingAttachments: container.querySelector('[data-chat-pending-attachments]'),
      input: container.querySelector('[data-chat-input]'),
      summary: container.querySelector('[data-chat-summary]'),
    };

    function setStatus(text) {
      if (state.refs.status) {
        state.refs.status.textContent = text || state.defaultStatus || '';
      }
    }

    function renderHistory() {
      if (!state.refs.history) return;
      if (!state.messages.length) {
        state.refs.history.innerHTML = '<div class="aiteam-inline-empty">当前会话还没有历史记录。</div>';
        return;
      }
      state.refs.history.innerHTML = state.messages.map(function (message) {
        return historyItem(message, state.selectedQuoteId);
      }).join('');
    }

    function renderQuoteBanner() {
      if (!state.refs.quoteBanner) return;
      if (!state.selectedQuoteId || !state.selectedQuotePreview) {
        state.refs.quoteBanner.innerHTML = '';
        return;
      }
      state.refs.quoteBanner.innerHTML = '<div class="aiteam-chat-quote-banner"><div class="aiteam-chat-quote-banner__content">' +
        '<strong>引用：</strong><span>' + escapeHtml(state.selectedQuotePreview) + '</span></div>' +
        '<button class="aiteam-button aiteam-button--ghost" type="button" data-chat-clear-quote>清除引用</button></div>';
      var clearBtn = state.refs.quoteBanner.querySelector('[data-chat-clear-quote]');
      if (clearBtn) {
        clearBtn.addEventListener('click', function () {
          state.selectedQuoteId = '';
          state.selectedQuotePreview = '';
          renderHistory();
          renderQuoteBanner();
        });
      }
    }

    function renderPendingAttachments() {
      if (!state.refs.pendingAttachments) return;
      if (!state.pendingAttachments.length) {
        state.refs.pendingAttachments.innerHTML = '';
        return;
      }
      state.refs.pendingAttachments.innerHTML = '<div class="aiteam-chat-pending-attachments__header"><strong>待发送附件</strong><button class="aiteam-button aiteam-button--ghost" type="button" data-chat-clear-attachments>清空附件</button></div>' + renderAttachmentList(state.pendingAttachments);
      var clearBtn = state.refs.pendingAttachments.querySelector('[data-chat-clear-attachments]');
      if (clearBtn) {
        clearBtn.addEventListener('click', function () {
          state.pendingAttachments = [];
          renderPendingAttachments();
        });
      }
    }

    function renderTranscript() {
      if (!state.refs.transcript) return;
      var html = '';
      if (!state.messages.length && !state.liveItems.length && !state.streamingAssistantText) {
        html = '<div class="aiteam-inline-empty">开始与这位数字员工对话吧，右侧可查看智能体详情。</div>';
      } else {
        html += state.messages.map(function (message) {
          return renderMessageBubble(message, '', state.employeeSummary, state.conversation);
        }).join('');
        html += state.liveItems.map(function (item) {
          if (item.kind === 'tool_call') {
            var p = item.payload || {};
            var st = normalizeToolStatus(p);
            return renderTimelineItem({
              type: 'tool_call',
              tool_name: p.tool_name || p.tool || p.name,
              tool_args: summarizeToolArgs(p),
              tool_result: summarizeToolResult(p),
              status_label: st.label,
            });
          }
          if (item.kind === 'loop' || item.kind === 'orchestration') {
            return renderTimelineItem({ type: 'loop', steps: (item.payload && item.payload.steps) || item.steps || [] });
          }
          return renderTimelineNotice(item.payload || item);
        }).join('');
        if (!state.streamingAssistantText && state.runId && !/run_succeeded|run_failed|run_cancelled/.test(state.latestEventType || '')) {
          html += renderThinking();
        }
        if (state.streamingAssistantText) {
          html += renderMessageBubble({
            role: 'assistant',
            sender_id: state.employeeId,
            created_at: new Date().toISOString(),
            text: state.streamingAssistantText,
            quote: null,
            attachments: [],
            citations: [],
            metadata: {},
          }, 'aiteam-message--streaming', state.employeeSummary, state.conversation);
        }
      }
      state.refs.transcript.innerHTML = html;
      state.refs.transcript.scrollTop = state.refs.transcript.scrollHeight;
    }

    function renderSummary() {
      if (!state.refs.summary) return;
      state.refs.summary.innerHTML = renderSummaryPanel(state.employeeSummary, state.conversation);
    }

    function renderAll() {
      renderHistory();
      renderQuoteBanner();
      renderPendingAttachments();
      renderTranscript();
      renderSummary();
      setStatus(state.statusText || '');
    }

    function normalizeConversation(data) {
      var conversation = data || {};
      state.conversation = conversation;
      state.employeeSummary = conversation.employee_summary || null;
      state.employeeId = (state.employeeSummary && state.employeeSummary.employee_id) || (conversation.employee_ref && conversation.employee_ref.employee_id) || state.employeeId;
      state.messages = Array.isArray(conversation.messages && conversation.messages.items) ? conversation.messages.items.slice() : [];
      state.nextCursor = conversation.messages && conversation.messages.next_cursor || 0;
      state.hasMore = !!(conversation.messages && conversation.messages.has_more);
      state.cursor = Math.max(state.cursor || 0, conversation.last_message_preview && conversation.last_message_preview.event_cursor || 0);
      state.runId = conversation.latest_run && conversation.latest_run.run_id || state.runId;
      state.latestRunStatus = conversation.latest_run && conversation.latest_run.status || state.latestRunStatus || '';
      if (!state.selectedQuoteId && state.messages.length) {
        var lastUser = state.messages.slice().reverse().find(function (message) { return message.role === 'user'; });
        if (lastUser) {
          state.selectedQuotePreview = '';
        }
      }
      state.lastMessagePreview = conversation.last_message_preview && conversation.last_message_preview.preview || (state.messages.length ? state.messages[state.messages.length - 1].text : '');
    }

    function reloadConversation(cursor, limit) {
      ns.api.get(buildConversationRequestPath(state.conversationId, cursor || 0, limit || 100)).then(function (result) {
        if (!result.ok) {
          setStatus(result.error || '刷新会话失败');
          return;
        }
        state.liveItems = [];
        state.streamingAssistantText = '';
        normalizeConversation(result.data || {});
        state.statusText = '已同步最新历史与员工摘要。';
        renderAll();
      });
    }

    function applyTimelineEvent(event) {
      if (!event || !event.event_type) {
        return;
      }
      state.cursor = Math.max(state.cursor || 0, Number(event.event_cursor) || 0);
      state.latestEventType = event.event_type;
      if (event.event_type === 'message_delta') {
        var text = (event.payload && event.payload.text) || event.preview || '';
        state.streamingAssistantText = (state.streamingAssistantText || '') + text;
        state.hasLiveDelta = !!state.streamingAssistantText;
        state.liveItems = state.liveItems.filter(function (item) { return item.kind !== 'recovery'; });
        state.statusText = '正在生成回复...';
      } else if (event.event_type === 'tool_call') {
        state.liveItems.push({ kind: 'tool_call', payload: event.payload || event });
        state.statusText = '员工正在调用工具处理任务...';
      } else if (event.event_type === 'routing_decided') {
        state.liveItems.push({ kind: 'notice', payload: event });
        state.statusText = '系统已决定路由，正在继续执行...';
      } else if (event.event_type === 'run_started') {
        state.liveItems.push({ kind: 'notice', payload: event });
        state.statusText = state.hasLiveDelta ? '继续接收回复中...' : '员工已开始处理本轮任务。';
      } else if (event.event_type === 'run_waiting_human') {
        state.liveItems.push({ kind: 'notice', payload: event });
        state.statusText = '当前运行等待人工补充信息。';
      } else if (event.event_type === 'heartbeat') {
        state.liveItems.push({ kind: 'notice', payload: event });
        state.statusText = state.hasLiveDelta ? '仍在持续生成回复...' : '运行仍在进行中。';
      } else if (event.event_type === 'run_succeeded' || event.event_type === 'run_failed' || event.event_type === 'run_cancelled') {
        state.liveItems.push({ kind: 'notice', payload: event });
        state.statusText = event.event_type === 'run_failed' ? '本次运行失败，可重试发送。' : (event.event_type === 'run_cancelled' ? '本次运行已取消，正在同步历史记录。' : '回复完成，正在同步历史记录。');
        renderAll();
        reloadConversation(0, 100);
        return;
      } else if (event.event_type === 'error') {
        state.liveItems.push({ kind: 'notice', payload: event });
        state.statusText = '时间线记录到过程异常，正在等待后续状态。';
      } else {
        state.liveItems.push({ kind: 'notice', payload: event });
      }
      renderAll();
    }

    function syncRun(runId, initialCursor) {
      if (!runId) {
        return;
      }
      state.runId = runId;
      state.cursor = Number(initialCursor) || state.cursor || 0;
      state.liveItems = [];
      state.streamingAssistantText = '';
      state.hasLiveDelta = false;
      state.latestEventType = '';
      state.statusText = 'queued / 正在唤起员工...';
      renderAll();
      ns.timeline.connect(runId, state.cursor, function (event) {
        applyTimelineEvent(event || {});
      }, {
        onReconnect: function (resumeCursor) {
          state.statusText = '连接中断，正在自动恢复...';
          state.liveItems = state.liveItems.filter(function (item) { return item.kind !== 'recovery'; });
          state.liveItems.push({ kind: 'recovery', payload: { event_type: 'heartbeat', preview: '网络抖动后已自动恢复，过程记录会继续回放。' } });
          renderAll();
        },
        onOpen: function (resumeCursor) {
          if (!state.runId) {
            return;
          }
          if ((Number(resumeCursor) || 0) > 0) {
            state.statusText = state.hasLiveDelta ? '已恢复流式连接，继续接收回复...' : '已恢复时间线连接，继续同步过程...';
            renderAll();
          }
        }
      });
      ns.api.getRunEvents(runId, state.cursor, 100).then(function (result) {
        if (!result.ok || !result.data || !Array.isArray(result.data.items)) {
          return;
        }
        result.data.items.forEach(function (event) {
          applyTimelineEvent(event);
        });
      });
    }

    function createRun(messageText) {
      state.lastSentText = messageText;
      state.statusText = '创建运行中...';
      renderAll();
      var body = {
        employee_id: state.employeeId,
        conversation_id: state.conversationId,
        message: {
          text: messageText,
        },
        idempotency_key: 'chat-' + state.conversationId + '-' + Date.now(),
      };
      if (state.selectedQuoteId) {
        body.message.quote_message_id = state.selectedQuoteId;
      }
      if (state.pendingAttachments.length) {
        body.message.attachments = state.pendingAttachments.map(function (item) {
          return {
            asset_id: item.asset_id,
            name: item.name,
            mime_type: item.mime_type,
            size: item.size,
            preview_url: item.preview_url,
          };
        });
      }
      ns.api.createRun(body).then(function (result) {
        if (!result.ok) {
          state.liveItems.push({ kind: 'notice', payload: { event_type: 'run_failed', preview: result.error || '消息发送失败，可重试。' } });
          state.statusText = '发送失败，可重试发送。';
          renderAll();
          return;
        }
        reloadConversation(0, 100);
        syncRun(result.data && result.data.run_id, state.cursor);
        state.selectedQuoteId = '';
        state.selectedQuotePreview = '';
        state.pendingAttachments = [];
        renderQuoteBanner();
        renderPendingAttachments();
        renderHistory();
      });
    }

    function retryLatestRun() {
      if (!state.runId) {
        if (!state.lastSentText) {
          setStatus('暂无可重试的上一条消息。');
          return;
        }
        createRun(state.lastSentText);
        return;
      }
      state.statusText = '正在重试上一轮运行...';
      renderAll();
      ns.api.retryRun(state.runId, {
        idempotency_key: 'retry-' + state.conversationId + '-' + Date.now(),
      }).then(function (result) {
        if (!result.ok) {
          state.statusText = result.error || '重试失败。';
          renderAll();
          return;
        }
        state.liveItems = [];
        state.streamingAssistantText = '';
        state.statusText = '已创建重试运行，正在同步时间线...';
        renderAll();
        reloadConversation(0, 100);
        syncRun(result.data && result.data.run_id, 0);
      });
    }

    function abortActiveRun() {
      if (!state.runId) {
        setStatus('当前没有可中止的运行。');
        return;
      }
      state.statusText = '正在提交中止请求...';
      renderAll();
      ns.api.abortRun(state.runId, {
        reason: '用户从单聊页主动停止本轮',
      }).then(function (result) {
        if (!result.ok) {
          state.statusText = result.error || '中止失败。';
          renderAll();
          return;
        }
        ns.timeline.disconnect();
        state.statusText = result.data && result.data.already_terminal ? '当前运行已结束，无需重复中止。' : '已提交中止请求，正在刷新会话。';
        state.liveItems.push({
          kind: 'notice',
          payload: {
            event_type: 'run_cancelled',
            preview: (result.data && result.data.status === 'cancelled') ? '本轮运行已取消。' : '中止请求已接收。',
          },
        });
        renderAll();
        reloadConversation(0, 100);
      });
    }

    var form = container.querySelector('[data-chat-form]');
    var input = state.refs.input;
    var quoteBtn = container.querySelector('[data-chat-quote]');
    var retryBtn = container.querySelector('[data-chat-retry]');
    var abortBtn = container.querySelector('[data-chat-abort]');
    var attachBtn = container.querySelector('[data-chat-attach]');
    var loadMoreBtn = container.querySelector('[data-chat-load-more]');

    if (form && input) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var text = String(input.value || '').trim();
        if (!text) return;
        input.value = '';
        createRun(text);
      });
      // Enter 直接发送，Shift+Enter 换行 — 与 Demo 交互一致。
      if (typeof input.addEventListener === 'function') input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          var text = String(input.value || '').trim();
          if (!text) return;
          input.value = '';
          createRun(text);
        }
      });
    }

    if (quoteBtn && input) {
      quoteBtn.addEventListener('click', function () {
        var fallback = state.messages.slice().reverse().find(function (message) {
          return message.role === 'assistant' || message.role === 'user';
        });
        if (!fallback) {
          setStatus('当前没有可引用的历史消息。');
          return;
        }
        state.selectedQuoteId = fallback.message_id;
        state.selectedQuotePreview = fallback.text || '';
        renderHistory();
        renderQuoteBanner();
        input.focus();
      });
    }

    if (retryBtn) {
      retryBtn.addEventListener('click', function () {
        retryLatestRun();
      });
    }

    if (abortBtn) {
      abortBtn.addEventListener('click', function () {
        abortActiveRun();
      });
    }

    if (attachBtn) {
      attachBtn.addEventListener('click', function () {
        state.statusText = '正在添加附件...';
        renderAll();
        ns.api.upload({ name: 'meeting-notes.txt', size: 128, mime_type: 'text/plain' }).then(function (result) {
          if (result.ok && result.data) {
            state.pendingAttachments = state.pendingAttachments.concat([result.data]);
            state.statusText = '附件已添加，将随下一条消息发送。';
          } else {
            state.statusText = result.error || '附件添加失败。';
          }
          renderAll();
        });
      });
    }

    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', function () {
        if (!state.hasMore) {
          setStatus('没有更多历史记录了。');
          return;
        }
        reloadConversation(state.nextCursor, 100);
      });
    }

    if (state.refs.history) {
      state.refs.history.addEventListener('click', function (event) {
        var button = event.target.closest('[data-history-message]');
        if (!button) return;
        var messageId = button.getAttribute('data-history-message');
        var matched = state.messages.find(function (item) { return item.message_id === messageId; });
        if (!matched) return;
        state.selectedQuoteId = matched.message_id;
        state.selectedQuotePreview = matched.text || '';
        renderHistory();
        renderQuoteBanner();
        if (input) input.focus();
      });
    }

    normalizeConversation(state.conversation);
    renderAll();

    if (state.runId && state.conversation.display_state && /waiting_reply|streaming|busy|reconnecting/.test(state.conversation.display_state)) {
      syncRun(state.runId, state.cursor);
    }
  }

  function presenceDotClass(status) {
    var s = String(status || '').toLowerCase();
    if (s === 'busy' || s === 'running' || s === 'streaming') return 'is-busy';
    if (s === 'offline' || s === 'paused') return 'is-offline';
    return 'is-online';
  }

  function renderAgentItem(a, activeConversationId) {
    var convId = a.conversation_id || '';
    var active = convId && String(convId) === String(activeConversationId) ? ' is-active' : '';
    var href = convId ? '/app/chat/' + encodeURIComponent(convId) : '/app/chat/' + encodeURIComponent(a.employee_id || '');
    var unread = a.unread_count ? '<div class="aiteam-chat__agent-unread">' + escapeHtml(String(a.unread_count)) + '</div>' : '';
    return '<a class="aiteam-chat__agent' + active + '" href="' + escapeHtml(href) + '" data-chat-agent="' + escapeHtml(a.employee_id || '') + '">' +
      '<div class="aiteam-chat__agent-avatar" style="background:' + escapeHtml(a.avatar_bg || 'linear-gradient(135deg,#2563EB,#0EA5E9)') + '">' + escapeHtml(a.avatar || '🤖') +
      '<span class="aiteam-chat__agent-dot ' + presenceDotClass(a.status) + '"></span></div>' +
      '<div class="aiteam-chat__agent-info"><div class="aiteam-chat__agent-name">' + escapeHtml(a.display_name || a.employee_id || '智能体') + '</div>' +
      '<div class="aiteam-chat__agent-role">' + escapeHtml(a.role_name || a.status_text || '数字员工') + '</div></div>' +
      '<div class="aiteam-chat__agent-meta"><div class="aiteam-chat__agent-time">' + escapeHtml(a.time_label || '') + '</div>' + unread + '</div>' +
      '</a>';
  }

  function renderGroupItem(g, activeConversationId) {
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

  // Split a flat agent array into {pinned, groups, others} for the demo layout.
  function classifyAgents(list) {
    var pinned = [];
    var others = [];
    (list || []).forEach(function (a) {
      if (a && (a.pinned || a.is_starred)) {
        pinned.push(a);
      } else {
        others.push(a);
      }
    });
    return { pinned: pinned, groups: [], others: others };
  }

  // sections: { pinned:[], groups:[], others:[] }
  function renderAgentList(sections, activeConversationId) {
    sections = sections || {};
    // Back-compat: a flat array means the old single-group shape.
    if (Array.isArray(sections)) {
      sections = classifyAgents(sections);
    }
    var pinned = sections.pinned || [];
    var groups = sections.groups || [];
    var others = sections.others || [];
    if (!pinned.length && !groups.length && !others.length) {
      return '<div class="aiteam-chat__agent-list"><div class="aiteam-inline-empty">暂无可用智能体</div></div>';
    }
    var html = '';
    if (pinned.length) {
      html += '<div class="aiteam-chat__group-label">📌 置顶</div>' +
        pinned.map(function (a) { return renderAgentItem(a, activeConversationId); }).join('');
    }
    if (groups.length) {
      html += '<div class="aiteam-chat__group-label">💼 工作群组</div>' +
        groups.map(function (g) { return renderGroupItem(g, activeConversationId); }).join('');
    }
    if (others.length) {
      html += '<div class="aiteam-chat__group-label">🤖 其他智能体</div>' +
        others.map(function (a) { return renderAgentItem(a, activeConversationId); }).join('');
    }
    return '<div class="aiteam-chat__agent-list">' + html + '</div>';
  }

  // Map raw getWorkbench() payload → {pinned, groups, others} for the agent list.
  function mapWorkbenchToSections(data) {
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
        pinned: !!(e.pinned || e.is_starred),
      };
      if (agent.pinned) {
        pinned.push(agent);
      } else {
        others.push(agent);
      }
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

  // Demo 对齐的消息中心三栏壳：左侧数字员工列表 / 中间会话 / 右侧智能体详情。
  function chatShell(opts) {
    opts = opts || {};
    return '<section class="aiteam-page aiteam-page--chat">' +
      '<div class="aiteam-chatwin">' +
      '<aside class="aiteam-chatwin__left">' +
      '<div class="aiteam-chatwin__left-head"><span class="aiteam-chatwin__left-title">🤖 数字员工</span>' +
      '<a class="aiteam-chatwin__add" href="/app/marketplace" title="招募数字员工">＋</a></div>' +
      '<div class="aiteam-chatwin__search"><input type="search" placeholder="🔍 搜索智能体..." data-chat-agent-search></div>' +
      opts.agentListHtml +
      '</aside>' +
      '<section class="aiteam-chatwin__main">' + opts.mainHtml + '</section>' +
      '<aside class="aiteam-chatwin__right">' +
      '<div class="aiteam-chatwin__right-head">智能体详情</div>' +
      '<div class="aiteam-chatwin__right-body" data-chat-summary>' + (opts.summaryHtml || '') + '</div>' +
      '</aside>' +
      '</div>' +
      '</section>';
  }

  function bindAgentSearch(container) {
    var search = container.querySelector('[data-chat-agent-search]');
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

  // Landing view for bare /app/chat — agent list + empty-state, no SSE/run binding.
  function renderLanding(container, workbenchData) {
    if (!container) return;
    var sections = mapWorkbenchToSections(workbenchData);
    var mainHtml = '<div class="aiteam-chatwin__header">' +
      '<div class="aiteam-chatwin__havatar">💬</div>' +
      '<div class="aiteam-chatwin__hinfo"><div class="aiteam-chatwin__hname">消息中心</div>' +
      '<div class="aiteam-chatwin__hstatus">选择左侧智能体或工作群组开始对话</div></div>' +
      '</div>' +
      '<div class="aiteam-chat-transcript aiteam-chatwin__transcript">' +
      '<div class="aiteam-inline-empty">从左侧选择一位智能体或工作群组，开始你的任务。<br>还没有数字员工？<a href="/app/marketplace">前往人才市场招募</a>。</div>' +
      '</div>';
    container.innerHTML = chatShell({
      agentListHtml: renderAgentList(sections, ''),
      mainHtml: mainHtml,
      summaryHtml: renderSummaryPanel(null, null),
    });
    bindAgentSearch(container);
  }

  function renderChat(container, conversation) {
    var summary = conversation.employee_summary || {};
    var displayName = summary.display_name || (conversation.employee_ref && conversation.employee_ref.display_name) || conversation.conversation_id;
    var roleName = summary.role_name || '';
    var modelLine = [summary.model_provider, summary.model_name].filter(Boolean).join(' · ');
    var headerName = roleName ? (displayName + ' · ' + roleName) : (displayName || '会话');
    var defaultStatus = ['在线', modelLine].filter(Boolean).join(' · ');
    var initial = (displayName || 'A').slice(0, 1);
    var mainHtml = '<div class="aiteam-chatwin__header">' +
      '<div class="aiteam-chatwin__havatar">' + escapeHtml(initial) + '</div>' +
      '<div class="aiteam-chatwin__hinfo"><div class="aiteam-chatwin__hname">' + escapeHtml(headerName) + '</div>' +
      '<div class="aiteam-chatwin__hstatus" data-chat-status>' + escapeHtml(defaultStatus) + '</div></div>' +
      '<div class="aiteam-chatwin__hactions">' +
      '<button class="aiteam-chatwin__tool" type="button" data-chat-load-more title="加载更早的历史">⇡</button>' +
      '</div>' +
      '</div>' +
      '<div class="aiteam-chat-transcript aiteam-chatwin__transcript" data-chat-transcript></div>' +
      '<div class="aiteam-chatwin__composer">' +
      '<div data-chat-quote-banner></div>' +
      '<div data-chat-pending-attachments></div>' +
      '<form class="aiteam-chatwin__inputbox" data-chat-form>' +
      '<textarea data-chat-input rows="2" placeholder="输入要交给员工处理的任务，Enter 发送，Shift+Enter 换行..."></textarea>' +
      '<div class="aiteam-chatwin__toolbar">' +
      '<button class="aiteam-chatwin__tool" type="button" data-chat-attach title="附件">📎</button>' +
      '<button class="aiteam-chatwin__tool" type="button" data-chat-quote title="引用最近一条消息">❝</button>' +
      '<button class="aiteam-chatwin__tool" type="button" data-chat-retry title="重试上一轮">↻</button>' +
      '<button class="aiteam-chatwin__tool" type="button" data-chat-abort title="停止本轮回复">⏹</button>' +
      '<span class="aiteam-chatwin__spacer"></span>' +
      (modelLine ? '<span class="aiteam-chatwin__model"><span class="aiteam-chatwin__model-dot"></span>' + escapeHtml(modelLine) + '</span>' : '') +
      '<button class="aiteam-chatwin__send" type="submit" title="发送 (Enter)">➤</button>' +
      '</div></form></div>';

    container.innerHTML = chatShell({
      agentListHtml: renderAgentList(conversation.__sections || conversation.__agentList || [], conversation.conversation_id),
      mainHtml: mainHtml,
      summaryHtml: '',
    });
    bindAgentSearch(container);

    bindChat(container, {
      defaultStatus: defaultStatus,
      conversationId: conversation.conversation_id,
      employeeId: summary.employee_id || (conversation.employee_ref && conversation.employee_ref.employee_id) || '',
      employeeSummary: summary,
      conversation: conversation,
      runId: conversation.latest_run && conversation.latest_run.run_id,
      cursor: conversation.last_message_preview && conversation.last_message_preview.event_cursor || 0,
      nextCursor: conversation.messages && conversation.messages.next_cursor || 0,
      hasMore: !!(conversation.messages && conversation.messages.has_more),
      messages: [],
      liveItems: [],
      streamingAssistantText: '',
      selectedQuoteId: '',
      selectedQuotePreview: '',
      lastSentText: '',
      latestRunStatus: conversation.latest_run && conversation.latest_run.status || '',
      lastMessagePreview: conversation.last_message_preview && conversation.last_message_preview.preview || '',
      pendingAttachments: [],
      statusText: '',
      refs: {},
    });
  }

  ns.pages.appChat = {
    render: renderChat,
    init: function (container, options) {
      if (!container) return;
      if (container.classList && container.classList.add) {
        container.classList.add('aiteam-main--flush');
      }
      var conversationId = getConversationId(options && options.pathname);
      if (!conversationId) {
        // Bare /app/chat → 消息中心 landing view.
        ns.states.renderLoading(container, '加载消息中心...');
        if (ns.api && typeof ns.api.getWorkbench === 'function') {
          ns.api.getWorkbench().then(function (wb) {
            renderLanding(container, (wb && wb.ok && wb.data) ? wb.data : {});
          }).catch(function () { renderLanding(container, {}); });
        } else {
          renderLanding(container, {});
        }
        return;
      }
      ns.states.renderLoading(container, '加载单聊会话...');
      ns.api.get(buildConversationRequestPath(conversationId, 0, 100)).then(function (result) {
        if (!result.ok) {
          ns.states.handleApiResult(result, container, function () {});
          return;
        }
        var conv = result.data || {};
        function finish(sections) {
          conv.__sections = sections || { pinned: [], groups: [], others: [] };
          renderChat(container, conv);
        }
        if (ns.api && typeof ns.api.getWorkbench === 'function') {
          ns.api.getWorkbench().then(function (wb) {
            finish(mapWorkbenchToSections((wb && wb.ok && wb.data) ? wb.data : {}));
          }).catch(function () { finish(null); });
        } else {
          finish(null);
        }
      });
    },
  };

  ns.pages.appChat._renderChat = renderChat;
  ns.pages.appChat._renderAgentList = renderAgentList;
  ns.pages.appChat._renderLanding = renderLanding;
  ns.pages.appChat._mapWorkbenchToSections = mapWorkbenchToSections;
  ns.pages.appChat._renderTimelineItem = renderTimelineItem;
  ns.pages.appChat._renderThinking = renderThinking;
  ns.pages.appChat._renderSummaryPanel = renderSummaryPanel;
}(window.aiteam));
