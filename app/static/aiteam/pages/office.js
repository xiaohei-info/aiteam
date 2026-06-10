window.aiteam = window.aiteam || {};

(function registerOfficePage(ns) {
  ns.pages = ns.pages || {};

  var PREVIEW_SCENE = {
    summary: {
      online_employee_count: 4,
      busy_employee_count: 2,
      running_task_count: 2,
      queue_depth: 0,
      waiting_reply_count: 0,
      mode_label: '预览模式 · 等待 /api/team/office/* 聚合接口',
    },
    seats: [
      {
        employee_id: 'preview_rex',
        display_name: 'Rex',
        role_name: '代码工程师',
        presence: {
          state: 'busy',
          current_task: '执行自动化回归测试',
          latest_event_cursor: 1,
          events_url: null,
          conversation_id: 'preview-conv-rex',
        },
      },
      {
        employee_id: 'preview_orion',
        display_name: 'Orion',
        role_name: '研究员',
        presence: {
          state: 'online',
          current_task: '查阅文档与方案',
          latest_event_cursor: 0,
          events_url: null,
          conversation_id: 'preview-conv-orion',
        },
      },
      {
        employee_id: 'preview_nova',
        display_name: 'Nova',
        role_name: '数据科学家',
        presence: {
          state: 'idle',
          current_task: '等待新任务',
          latest_event_cursor: 0,
          events_url: null,
        },
      },
      {
        employee_id: 'preview_iris',
        display_name: 'Iris',
        role_name: '内容创作师',
        presence: {
          state: 'offline',
          current_task: '当前未上线',
          latest_event_cursor: 0,
          events_url: null,
        },
      },
    ],
    generated_cursor: 0,
    refresh_hint_ms: 30000,
  };

  var PREVIEW_FEED = {
    items: [
      {
        run_id: 'preview-run-rex',
        employee_id: 'preview_rex',
        employee_display_name: 'Rex',
        status: 'running',
        display_state: 'busy',
        preview: '执行自动化回归测试',
        event_type: 'run_status',
        latest_event_cursor: 1,
        events_url: null,
        event_ts: new Date().toISOString(),
      },
      {
        run_id: 'preview-run-orion',
        employee_id: 'preview_orion',
        employee_display_name: 'Orion',
        status: 'running',
        display_state: 'busy',
        preview: '整理方案文档',
        event_type: 'run_status',
        latest_event_cursor: 1,
        events_url: null,
        event_ts: new Date().toISOString(),
      },
      {
        run_id: null,
        employee_id: 'preview_nova',
        employee_display_name: 'Nova',
        status: 'pending',
        display_state: 'idle',
        preview: '等待新队列',
        event_type: 'run_status',
        latest_event_cursor: 0,
        events_url: null,
        event_ts: new Date().toISOString(),
      },
    ],
    queue: { queued: 1, running: 2, waiting_human: 0, failed: 0 },
    generated_cursor: 0,
    refresh_hint_ms: 30000,
  };

  var _state = {
    isPreview: false,
    sceneData: null,
    feedData: null,
    selectedSeat: null,
    selectedRunId: null,
    selectedRunCursor: 0,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    lastDragX: 0,
    lastDragY: 0,
    pollTimer: null,
    timelineConnected: false,
    logs: [],
  };

  var _elements = {
    container: null,
    sceneRoot: null,
    seatsContainer: null,
    bottomPanel: null,
    taskList: null,
    logList: null,
    fullscreenBtn: null,
    detailPanel: null,
  };

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function seatStatusLabel(value) {
    var state = String(value || 'idle').toLowerCase();
    if (state === 'busy' || state === 'running' || state === 'working') return '忙碌';
    if (state === 'online' || state === 'active') return '在线';
    if (state === 'offline' || state === 'paused') return '离线';
    return '空闲';
  }

  function taskStatusLabel(status) {
    if (status === 'completed' || status === 'succeeded' || status === 'done') return '已完成';
    if (status === 'running' || status === 'busy') return '进行中';
    if (status === 'failed' || status === 'error') return '失败';
    if (status === 'waiting_human') return '待回复';
    return '待处理';
  }

  function taskHref(item) {
    if (item && item.conversation_id) {
      return '/app/chat/' + encodeURIComponent(item.conversation_id);
    }
    if (item && item.employee_id) {
      return '/admin/employees/' + encodeURIComponent(item.employee_id);
    }
    return '#';
  }

  function hasLiveScene(sceneResult) {
    var scene = sceneResult && sceneResult.data;
    var summary = scene && scene.summary;
    var seats = scene && scene.seats;
    return !!(
      sceneResult &&
      sceneResult.ok &&
      summary &&
      typeof summary === 'object' &&
      Array.isArray(seats) &&
      seats.length > 0
    );
  }

  function hasLiveFeed(feedResult) {
    var feed = feedResult && feedResult.data;
    return !!(feedResult && feedResult.ok && feed && Array.isArray(feed.items));
  }

  function normalizeScene(sceneResult, feedResult) {
    var scene = (sceneResult && sceneResult.data) || {};
    var feed = (feedResult && feedResult.data) || {};
    if (!hasLiveScene(sceneResult) || !hasLiveFeed(feedResult)) {
      return {
        preview: true,
        scene: PREVIEW_SCENE,
        feed: PREVIEW_FEED,
      };
    }
    return {
      preview: false,
      scene: {
        summary: scene.summary,
        seats: scene.seats,
        generated_cursor: scene.generated_cursor,
        refresh_hint_ms: scene.refresh_hint_ms,
      },
      feed: {
        items: feed.items || [],
        queue: feed.queue || { queued: 0, running: 0, waiting_human: 0, failed: 0 },
        generated_cursor: feed.generated_cursor,
        refresh_hint_ms: feed.refresh_hint_ms,
      },
    };
  }

  function renderToolbar(summary, isPreview) {
    var s = summary || {};
    var onlineCount = s.online_employee_count || 0;
    var runningCount = s.running_task_count || 0;
    var modeLabel = isPreview
      ? (s.mode_label || '预览模式 · 等待 /api/team/office/* 聚合接口')
      : '实时视图 · Team Panel 聚合';

    return (
      '<div class="aiteam-office-scene__toolbar">' +
      '<div class="aiteam-office-scene__toolbar-left">' +
      '<div class="aiteam-office-scene__toolbar-title">' +
      '<span class="aiteam-office-scene__toolbar-icon">🏢</span>' +
      '<span>办公室动态</span>' +
      '</div>' +
      '<div class="aiteam-office-scene__toolbar-subtitle">' + escapeHtml(modeLabel) + '</div>' +
      '</div>' +
      '<div class="aiteam-office-scene__toolbar-center">' +
      '<div class="aiteam-office-scene__stat-badge is-online">' +
      '<span class="aiteam-office-scene__stat-dot"></span>' +
      '<span>' + onlineCount + ' 位在线</span>' +
      '</div>' +
      '<div class="aiteam-office-scene__stat-badge is-busy">' +
      '<span class="aiteam-office-scene__stat-dot"></span>' +
      '<span>' + runningCount + ' 个任务执行中</span>' +
      '</div>' +
      '</div>' +
      '<div class="aiteam-office-scene__toolbar-right">' +
      '<span class="aiteam-office-scene__toolbar-hint">拖拽平移 · 滚轮缩放</span>' +
      '<button type="button" class="aiteam-office-scene__fullscreen-btn" data-office-fullscreen>全屏查看</button>' +
      '</div>' +
      '</div>'
    );
  }

  function renderSeat(seat, index) {
    var presence = seat.presence || {};
    var state = String(presence.state || 'idle').toLowerCase();
    var hasTask = !!presence.current_task;
    var hasEvents = !!(presence.events_url || presence.latest_event_cursor);
    var isSelected = _state.selectedSeat && _state.selectedSeat.employee_id === seat.employee_id;

    return (
      '<div class="aiteam-office-scene__seat-wrapper" data-seat-index="' + index + '">' +
      '<div class="aiteam-office-scene__seat is-' + escapeHtml(state) + (isSelected ? ' is-selected' : '') + '"' +
      ' data-employee-id="' + escapeHtml(seat.employee_id) + '" role="button" tabindex="0">' +
      '<div class="aiteam-office-scene__seat-header">' +
      '<span class="aiteam-office-scene__seat-avatar">' + (seat.display_name ? seat.display_name.charAt(0) : '🤖') + '</span>' +
      '<span class="aiteam-office-scene__seat-status is-' + escapeHtml(state) + '">' + escapeHtml(seatStatusLabel(state)) + '</span>' +
      '</div>' +
      '<div class="aiteam-office-scene__seat-name">' + escapeHtml(seat.display_name || seat.employee_id || '未命名') + '</div>' +
      '<div class="aiteam-office-scene__seat-role">' + escapeHtml(seat.role_name || '数字员工') + '</div>' +
      (hasTask ? '<div class="aiteam-office-scene__task-bubble">' + escapeHtml(presence.current_task) + '</div>' : '') +
      '</div>' +
      '</div>'
    );
  }

  function renderScene(payload) {
    var summary = payload.scene.summary || {};
    var seats = payload.scene.seats || [];
    var isPreview = payload.preview;

    return (
      '<div class="aiteam-office-scene__viewport" data-scene-viewport>' +
      '<div class="aiteam-office-scene__scene-root" data-scene-root>' +
      '<div class="aiteam-office-scene__seats-container" data-seats-container>' +
      seats.map(renderSeat).join('') +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function renderTaskItem(item) {
    var statusClass = String(item.display_state || item.status || 'pending').toLowerCase();
    var href = taskHref(item);
    var previewText = item.preview || '等待更新';
    var eventType = item.event_type || 'run_status';

    return (
      '<div class="aiteam-office-scene__task-item" data-task-employee="' + escapeHtml(item.employee_id || '') + '" data-run-id="' + escapeHtml(item.run_id || '') + '">' +
      '<div class="aiteam-office-scene__task-avatar" style="background:linear-gradient(135deg,#2563EB,#0EA5E9)">' +
      (item.employee_display_name ? item.employee_display_name.charAt(0) : '🤖') +
      '</div>' +
      '<div class="aiteam-office-scene__task-content">' +
      '<div class="aiteam-office-scene__task-title">' + escapeHtml(previewText) + '</div>' +
      '<div class="aiteam-office-scene__task-desc">' + escapeHtml((item.employee_display_name || '系统') + ' · ' + eventType) + '</div>' +
      '</div>' +
      '<span class="aiteam-office-scene__task-status is-' + escapeHtml(statusClass) + '">' + escapeHtml(taskStatusLabel(item.status)) + '</span>' +
      '</div>'
    );
  }

  function renderTaskList(tasks) {
    if (!tasks || !tasks.length) {
      return '<div class="aiteam-office-scene__task-empty">当前暂无运行中的任务队列</div>';
    }
    return '<div class="aiteam-office-scene__task-list">' + tasks.map(renderTaskItem).join('') + '</div>';
  }

  function renderStats(summary, queue) {
    var s = summary || {};
    var q = queue || { queued: 0, running: 0, waiting_human: 0, failed: 0 };
    var online = s.online_employee_count || 0;
    var busy = s.busy_employee_count || 0;
    var running = q.running || 0;
    var queued = q.queued || 0;

    return (
      '<div class="aiteam-office-scene__stat-grid">' +
      '<div class="aiteam-office-scene__stat-box">' +
      '<div class="aiteam-office-scene__stat-value is-brand">' + running + '</div>' +
      '<div class="aiteam-office-scene__stat-label">运行中</div>' +
      '</div>' +
      '<div class="aiteam-office-scene__stat-box">' +
      '<div class="aiteam-office-scene__stat-value is-green">' + online + '</div>' +
      '<div class="aiteam-office-scene__stat-label">在线</div>' +
      '</div>' +
      '<div class="aiteam-office-scene__stat-box">' +
      '<div class="aiteam-office-scene__stat-value is-purple">' + busy + '</div>' +
      '<div class="aiteam-office-scene__stat-label">忙碌</div>' +
      '</div>' +
      '<div class="aiteam-office-scene__stat-box">' +
      '<div class="aiteam-office-scene__stat-value is-yellow">' + queued + '</div>' +
      '<div class="aiteam-office-scene__stat-label">排队</div>' +
      '</div>' +
      '</div>'
    );
  }

  function renderLogItem(log) {
    var eventType = log.event_type || 'log';
    var time = log.event_ts ? log.event_ts.substring(11, 19) : log.time || '';
    var agent = log.agent || log.run_id || 'System';
    var text = log.text || log.preview || JSON.stringify(log.payload || {});
    return (
      '<div class="aiteam-office-scene__log-item" data-event-cursor="' + (log.event_cursor || '') + '">' +
      '<span class="aiteam-office-scene__log-time">' + escapeHtml(time) + '</span>' +
      '<span class="aiteam-office-scene__log-agent">' + escapeHtml(agent) + '</span>' +
      '<span class="aiteam-office-scene__log-text">' + escapeHtml(text) + '</span>' +
      '<span class="aiteam-office-scene__log-type">' + escapeHtml(eventType) + '</span>' +
      '</div>'
    );
  }

  function renderLogList(logs) {
    if (!logs || !logs.length) {
      return '<div class="aiteam-office-scene__log-empty">暂无实时日志</div>';
    }
    return '<div class="aiteam-office-scene__log-list" data-log-list>' + logs.map(renderLogItem).join('') + '</div>';
  }

  function renderDetailPanel() {
    var seat = _state.selectedSeat;
    if (!seat) {
      return '<div class="aiteam-office-scene__detail-panel is-empty" data-detail-panel><div class="aiteam-office-scene__detail-placeholder">点击工位查看详情</div></div>';
    }

    var presence = seat.presence || {};
    var state = presence.state || 'idle';
    var hasEvents = !!(presence.events_url || presence.latest_event_cursor);
    var chatLink = presence.conversation_id ? '/app/chat/' + encodeURIComponent(presence.conversation_id) : null;
    var eventsLink = presence.events_url || (presence.current_run_id ? '/api/team/runs/' + presence.current_run_id + '/events' : null);

    return (
      '<div class="aiteam-office-scene__detail-panel" data-detail-panel>' +
      '<div class="aiteam-office-scene__detail-header">' +
      '<div class="aiteam-office-scene__detail-avatar">' + (seat.display_name ? seat.display_name.charAt(0) : '🤖') + '</div>' +
      '<div class="aiteam-office-scene__detail-info">' +
      '<div class="aiteam-office-scene__detail-name">' + escapeHtml(seat.display_name || '未命名') + '</div>' +
      '<div class="aiteam-office-scene__detail-role">' + escapeHtml(seat.role_name || '数字员工') + '</div>' +
      '</div>' +
      '<div class="aiteam-office-scene__detail-status is-' + escapeHtml(state) + '">' + escapeHtml(seatStatusLabel(state)) + '</div>' +
      '</div>' +
      '<div class="aiteam-office-scene__detail-section">' +
      '<div class="aiteam-office-scene__detail-label">当前任务</div>' +
      '<div class="aiteam-office-scene__detail-value">' + escapeHtml(presence.current_task || '无') + '</div>' +
      '</div>' +
      '<div class="aiteam-office-scene__detail-section">' +
      '<div class="aiteam-office-scene__detail-label">最新游标</div>' +
      '<div class="aiteam-office-scene__detail-value">#' + (presence.latest_event_cursor || 0) + '</div>' +
      '</div>' +
      '<div class="aiteam-office-scene__detail-actions">' +
      (chatLink ? '<a href="' + chatLink + '" class="aiteam-office-scene__detail-link">打开对话</a>' : '') +
      (hasEvents ? '<button type="button" class="aiteam-office-scene__detail-btn" data-view-events>查看事件流</button>' : '') +
      '<button type="button" class="aiteam-office-scene__detail-btn" data-clear-selection>清除选择</button>' +
      '</div>' +
      '</div>'
    );
  }

  function renderBottomPanel(payload) {
    var tasks = payload.feed.items || [];
    var queue = payload.feed.queue || { queued: 0, running: 0, waiting_human: 0, failed: 0 };
    var summary = payload.scene.summary || {};
    var logs = _state.logs || [];

    return (
      '<div class="aiteam-office-scene__bottom-panel" data-bottom-panel>' +
      '<div class="aiteam-office-scene__bp-section">' +
      '<div class="aiteam-office-scene__bp-title">' +
      '<span>🦞</span>' +
      '<span>任务队列</span>' +
      '</div>' +
      renderTaskList(tasks) +
      '</div>' +
      '<div class="aiteam-office-scene__bp-section">' +
      '<div class="aiteam-office-scene__bp-title">' +
      '<span>📊</span>' +
      '<span>状态统计</span>' +
      '</div>' +
      renderStats(summary, queue) +
      '</div>' +
      '<div class="aiteam-office-scene__bp-section">' +
      '<div class="aiteam-office-scene__bp-title">' +
      '<span>📡</span>' +
      '<span>实时日志</span>' +
      '</div>' +
      renderLogList(logs) +
      '</div>' +
      '<div class="aiteam-office-scene__bp-section is-detail">' +
      '<div class="aiteam-office-scene__bp-title">' +
      '<span>👤</span>' +
      '<span>工位详情</span>' +
      '</div>' +
      renderDetailPanel() +
      '</div>' +
      '</div>'
    );
  }

  function render(payload) {
    var summary = payload.scene.summary || {};
    var isPreview = payload.preview;

    return (
      '<div class="aiteam-office-scene' + (isPreview ? ' is-preview' : '') + '">' +
      renderToolbar(summary, isPreview) +
      renderScene(payload) +
      renderBottomPanel(payload) +
      '</div>'
    );
  }

  function handleWheel(e) {
    if (!_elements.sceneRoot) return;
    e.preventDefault();
    var delta = e.deltaY > 0 ? 0.9 : 1.1;
    _state.scale = Math.max(0.5, Math.min(2.0, _state.scale * delta));
    updateTransform();
  }

  function handleMouseDown(e) {
    if (e.target.closest('.aiteam-office-scene__seat')) return;
    _state.isDragging = true;
    _state.dragStartX = e.clientX;
    _state.dragStartY = e.clientY;
    _state.lastDragX = _state.offsetX;
    _state.lastDragY = _state.offsetY;
    if (_elements.sceneRoot) {
      _elements.sceneRoot.style.cursor = 'grabbing';
    }
  }

  function handleMouseMove(e) {
    if (!_state.isDragging) return;
    var dx = e.clientX - _state.dragStartX;
    var dy = e.clientY - _state.dragStartY;
    _state.offsetX = _state.lastDragX + dx;
    _state.offsetY = _state.lastDragY + dy;
    updateTransform();
  }

  function handleMouseUp() {
    _state.isDragging = false;
    if (_elements.sceneRoot) {
      _elements.sceneRoot.style.cursor = 'grab';
    }
  }

  function updateTransform() {
    if (!_elements.seatsContainer) return;
    _elements.seatsContainer.style.transform = 'translate(' + _state.offsetX + 'px, ' + _state.offsetY + 'px) scale(' + _state.scale + ')';
  }

  function toggleFullscreen() {
    var scene = _elements.container && _elements.container.querySelector('.aiteam-office-scene');
    if (!scene) return;

    var isFullscreen = scene.classList.contains('is-fullscreen');
    if (isFullscreen) {
      scene.classList.remove('is-fullscreen');
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(function () {});
      }
    } else {
      scene.classList.add('is-fullscreen');
      if (scene.requestFullscreen) {
        scene.requestFullscreen().catch(function () {});
      }
    }
    updateFullscreenButton();
  }

  function updateFullscreenButton() {
    if (!_elements.fullscreenBtn) return;
    var scene = _elements.container && _elements.container.querySelector('.aiteam-office-scene');
    var isFullscreen = scene && scene.classList.contains('is-fullscreen');
    _elements.fullscreenBtn.textContent = isFullscreen ? '退出全屏' : '全屏查看';
  }

  function selectSeat(seat) {
    _state.selectedSeat = seat;
    _state.selectedRunId = null;
    _state.selectedRunCursor = 0;
    disconnectTimeline();

    if (seat && seat.presence) {
      var presence = seat.presence;
      if (presence.current_run_id) {
        _state.selectedRunId = presence.current_run_id;
        _state.selectedRunCursor = presence.latest_event_cursor || 0;
        connectTimeline(_state.selectedRunId, _state.selectedRunCursor);
      }
    }

    refreshDetailPanel();
    refreshSeatSelection();
  }

  function clearSelection() {
    _state.selectedSeat = null;
    _state.selectedRunId = null;
    _state.selectedRunCursor = 0;
    _state.logs = [];
    disconnectTimeline();
    refreshDetailPanel();
    refreshSeatSelection();
  }

  function refreshSeatSelection() {
    if (!_elements.seatsContainer) return;
    var seats = _elements.seatsContainer.querySelectorAll('.aiteam-office-scene__seat');
    seats.forEach(function (seatEl) {
      var employeeId = seatEl.getAttribute('data-employee-id');
      var isSelected = _state.selectedSeat && _state.selectedSeat.employee_id === employeeId;
      if (isSelected) {
        seatEl.classList.add('is-selected');
      } else {
        seatEl.classList.remove('is-selected');
      }
    });
  }

  function refreshDetailPanel() {
    if (!_elements.container) return;
    var detailPanel = _elements.container.querySelector('[data-detail-panel]');
    if (detailPanel) {
      detailPanel.outerHTML = renderDetailPanel();
      bindDetailPanelEvents();
    }
  }

  function bindDetailPanelEvents() {
    var clearBtn = _elements.container.querySelector('[data-clear-selection]');
    if (clearBtn) {
      clearBtn.addEventListener('click', function (e) {
        e.preventDefault();
        clearSelection();
      });
    }

    var viewEventsBtn = _elements.container.querySelector('[data-view-events]');
    if (viewEventsBtn) {
      viewEventsBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (_state.selectedSeat && _state.selectedSeat.presence && _state.selectedSeat.presence.events_url) {
          window.open(_state.selectedSeat.presence.events_url, '_blank');
        }
      });
    }
  }

  function hydrateRunEvents(runId, cursor) {
    if (!runId || !ns.api.getRunEvents) return Promise.resolve([]);
    return ns.api.getRunEvents(runId, cursor, 100).then(function (result) {
      if (!result.ok || !result.data || !Array.isArray(result.data.items)) {
        return [];
      }
      return result.data.items;
    }).catch(function () {
      return [];
    });
  }

  function connectTimeline(runId, cursor) {
    if (!runId || !ns.timeline) return;

    hydrateRunEvents(runId, cursor).then(function (events) {
      events.forEach(function (event) {
        addLogEntry(event);
      });

      var lastCursor = events.length > 0 ? events[events.length - 1].event_cursor : cursor;

      _state.timelineConnected = true;
      ns.timeline.connect(runId, lastCursor, function (event) {
        addLogEntry(event);
      }, {
        onOpen: function () {
          _state.timelineConnected = true;
        },
        onReconnect: function (resumeCursor) {
          hydrateRunEvents(runId, resumeCursor).then(function (events) {
            events.forEach(function (event) {
              addLogEntry(event);
            });
          });
        },
      });
    });
  }

  function disconnectTimeline() {
    if (ns.timeline) {
      ns.timeline.disconnect();
    }
    _state.timelineConnected = false;
  }

  function addLogEntry(event) {
    if (!event) return;
    var logEntry = {
      event_cursor: event.event_cursor,
      event_ts: event.event_ts,
      event_type: event.event_type,
      run_id: event.run_id,
      agent: _state.selectedSeat ? _state.selectedSeat.display_name : 'System',
      text: event.preview || (event.payload ? (event.payload.message || JSON.stringify(event.payload)) : ''),
      preview: event.preview,
      payload: event.payload,
    };
    _state.logs.unshift(logEntry);
    if (_state.logs.length > 50) {
      _state.logs.pop();
    }
    refreshLogList();
  }

  function refreshLogList() {
    if (!_elements.container) return;
    var logList = _elements.container.querySelector('[data-log-list]');
    if (logList) {
      logList.outerHTML = renderLogList(_state.logs);
    }
  }

  function bindEvents() {
    if (!_elements.container) return;
    if (typeof _elements.container.querySelector !== 'function') return;

    _elements.fullscreenBtn = _elements.container.querySelector('[data-office-fullscreen]');
    if (_elements.fullscreenBtn) {
      _elements.fullscreenBtn.addEventListener('click', function (e) {
        e.preventDefault();
        toggleFullscreen();
      });
    }

    _elements.sceneRoot = _elements.container.querySelector('[data-scene-root]');
    _elements.seatsContainer = _elements.container.querySelector('[data-seats-container]');
    _elements.logList = _elements.container.querySelector('[data-log-list]');

    if (_elements.sceneRoot) {
      _elements.sceneRoot.style.cursor = 'grab';
      _elements.sceneRoot.addEventListener('wheel', handleWheel, { passive: false });
      _elements.sceneRoot.addEventListener('mousedown', handleMouseDown);
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    var seats = _elements.container.querySelectorAll('.aiteam-office-scene__seat');
    seats.forEach(function (seatEl) {
      seatEl.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var employeeId = seatEl.getAttribute('data-employee-id');
        var seats = _state.sceneData && _state.sceneData.seats ? _state.sceneData.seats : [];
        var seat = seats.find(function (s) { return s.employee_id === employeeId; });
        if (seat) {
          selectSeat(seat);
        }
      });
      seatEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          seatEl.click();
        }
      });
    });

    var viewLogBtns = _elements.container.querySelectorAll('[data-view-run]');
    viewLogBtns.forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var employeeId = btn.getAttribute('data-view-run');
        var seats = _state.sceneData && _state.sceneData.seats ? _state.sceneData.seats : [];
        var seat = seats.find(function (s) { return s.employee_id === employeeId; });
        if (seat) {
          selectSeat(seat);
        }
      });
    });

    var taskItems = _elements.container.querySelectorAll('.aiteam-office-scene__task-item');
    taskItems.forEach(function (itemEl) {
      itemEl.addEventListener('click', function (e) {
        var runId = itemEl.getAttribute('data-run-id');
        var employeeId = itemEl.getAttribute('data-task-employee');
        if (runId) {
          var seats = _state.sceneData && _state.sceneData.seats ? _state.sceneData.seats : [];
          var seat = seats.find(function (s) { return s.employee_id === employeeId; });
          if (seat) {
            selectSeat(seat);
          }
        }
      });
    });

    bindDetailPanelEvents();
  }

  function unbindEvents() {
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }

  function refreshData() {
    if (!_elements.container) return;

    Promise.all([ns.api.getOfficeScene(), ns.api.getOfficeFeed()]).then(function (results) {
      var sceneResult = results[0];
      var feedResult = results[1];

      var payload = normalizeScene(sceneResult, feedResult);
      _state.isPreview = payload.preview;
      _state.sceneData = payload.scene;
      _state.feedData = payload.feed;

      if (_elements.container) {
        _elements.container.innerHTML = render(payload);
        bindEvents();
        updateTransform();
      }
    }).catch(function () {
      var payload = normalizeScene({ ok: false }, { ok: false });
      _state.isPreview = payload.preview;
      _state.sceneData = payload.scene;
      _state.feedData = payload.feed;

      if (_elements.container) {
        _elements.container.innerHTML = render(payload);
        bindEvents();
        updateTransform();
      }
    });
  }

  function startPolling(refreshMs) {
    stopPolling();
    if (refreshMs && refreshMs > 0) {
      _state.pollTimer = setInterval(refreshData, refreshMs);
    }
  }

  function stopPolling() {
    if (_state.pollTimer) {
      clearInterval(_state.pollTimer);
      _state.pollTimer = null;
    }
  }

  function cleanup() {
    stopPolling();
    disconnectTimeline();
    unbindEvents();
    _elements.container = null;
    _elements.sceneRoot = null;
    _elements.seatsContainer = null;
    _elements.bottomPanel = null;
    _elements.taskList = null;
    _elements.logList = null;
    _elements.fullscreenBtn = null;
    _elements.detailPanel = null;
  }

  ns.pages.office = {
    get _pollTimer() { return _state.pollTimer; },
    set _pollTimer(val) { _state.pollTimer = val; },
    _state: _state,
    _elements: _elements,

    _stopPolling: function () {
      stopPolling();
    },

    _refreshData: function () {
      refreshData();
    },

    _cleanup: function () {
      cleanup();
    },

    init: function (container) {
      if (!container) return;
      _elements.container = container;

      if (ns.states && ns.states.renderLoading) {
        ns.states.renderLoading(container);
      } else {
        container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载办公室动态...</p></div>';
      }

      Promise.all([ns.api.getOfficeScene(), ns.api.getOfficeFeed()]).then(function (results) {
        var sceneResult = results[0];
        var feedResult = results[1];

        if (!sceneResult.ok || !feedResult.ok) {
          var payload = normalizeScene({ ok: false }, { ok: false });
          _state.isPreview = payload.preview;
          _state.sceneData = payload.scene;
          _state.feedData = payload.feed;

          container.innerHTML = render(payload);
          bindEvents();
          updateTransform();

          startPolling(30000);
          return;
        }

        var payload = normalizeScene(sceneResult, feedResult);
        _state.isPreview = payload.preview;
        _state.sceneData = payload.scene;
        _state.feedData = payload.feed;

        container.innerHTML = render(payload);
        bindEvents();
        updateTransform();

        var refreshMs = payload.feed.refresh_hint_ms || payload.scene.refresh_hint_ms || 30000;
        startPolling(refreshMs);
      }).catch(function () {
        var payload = normalizeScene({ ok: false }, { ok: false });
        _state.isPreview = payload.preview;
        _state.sceneData = payload.scene;
        _state.feedData = payload.feed;

        container.innerHTML = render(payload);
        bindEvents();
        updateTransform();

        startPolling(30000);
      });
    },
  };
}(window.aiteam));
