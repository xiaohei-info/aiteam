window.aiteam = window.aiteam || {};

(function registerOfficePage(ns) {
  ns.pages = ns.pages || {};
  var OFFICE_SCENE_PATH = '/api/team/office/scene';
  var OFFICE_FEED_PATH = '/api/team/office/feed';
  var VIEWPORT_MIN_SCALE = 0.7;
  var VIEWPORT_MAX_SCALE = 1.6;
  var VIEWPORT_SCALE_STEP = 0.15;
  var VIEWPORT_PAN_STEP = 80;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function stringValue(value, fallback) {
    var text = String(value == null ? '' : value).trim();
    return text || (fallback || '');
  }

  function seatPresenceState(seat) {
    var raw = seat && seat.presence;
    if (raw && typeof raw === 'object' && raw.state) return String(raw.state).toLowerCase();
    return String(raw || seat && seat.status || 'idle').toLowerCase();
  }

  function seatTaskPreview(seat) {
    var raw = seat && seat.presence;
    if (raw && typeof raw === 'object' && raw.current_task) return String(raw.current_task);
    return stringValue(seat && seat.current_task, '等待任务');
  }

  function seatEventCursor(seat) {
    var raw = seat && seat.presence;
    if (raw && typeof raw === 'object' && raw.latest_event_cursor != null) return raw.latest_event_cursor;
    return seat && seat.latest_event_cursor != null ? seat.latest_event_cursor : null;
  }

  function seatEventsUrl(seat) {
    var raw = seat && seat.presence;
    if (raw && typeof raw === 'object' && raw.events_url) return String(raw.events_url);
    return stringValue(seat && seat.events_url, '');
  }

  function seatStatusLabel(value) {
    if (value === 'busy' || value === 'running' || value === 'working' || value === 'streaming') return '忙碌';
    if (value === 'online' || value === 'active') return '在线';
    if (value === 'offline' || value === 'paused') return '离线';
    if (value === 'failed' || value === 'error') return '异常';
    return '空闲';
  }

  function taskStatusLabel(value, progress) {
    if (value === 'done' || value === 'completed' || value === 'succeeded' || Number(progress) >= 100) return '已完成';
    if (value === 'running' || value === 'busy' || value === 'streaming') return '进行中';
    if (value === 'failed' || value === 'error') return '失败';
    return '待处理';
  }

  function resolveConversationHref(conversationId, convType, navigationTarget) {
    var explicit = stringValue(navigationTarget, '');
    if (explicit) return explicit;
    if (!conversationId) return '';
    if (String(convType || '').toLowerCase() === 'group') {
      return '/app/group/' + encodeURIComponent(conversationId);
    }
    return '/app/chat/' + encodeURIComponent(conversationId);
  }

  function taskHref(item) {
    var target = resolveConversationHref(
      item && item.conversation_id,
      item && item.conv_type,
      item && item.navigation_target
    );
    if (target) return target;
    if (item && item.employee_id) return '/admin/employees/' + encodeURIComponent(item.employee_id);
    return '#';
  }

  function normalizeViewportState(state) {
    var next = state || {};
    var rawScale = Number(next.scale);
    if (!Number.isFinite(rawScale) || rawScale <= 0) rawScale = 1;
    rawScale = Math.max(VIEWPORT_MIN_SCALE, Math.min(VIEWPORT_MAX_SCALE, rawScale));
    var offsetX = Number(next.offsetX);
    var offsetY = Number(next.offsetY);
    return {
      scale: Number(rawScale.toFixed(2)),
      offsetX: Number.isFinite(offsetX) ? Math.round(offsetX) : 0,
      offsetY: Number.isFinite(offsetY) ? Math.round(offsetY) : 0,
    };
  }

  function viewportTransform(state) {
    var view = normalizeViewportState(state);
    return 'translate(' + view.offsetX + 'px, ' + view.offsetY + 'px) scale(' + String(view.scale) + ')';
  }

  function viewportScaleLabel(state) {
    var view = normalizeViewportState(state);
    return String(Math.round(view.scale * 100)) + '%';
  }

  function findSeatById(seats, seatId) {
    if (!seatId) return seats[0] || null;
    for (var i = 0; i < seats.length; i += 1) {
      if (String(seats[i].employee_id || '') === String(seatId)) return seats[i];
    }
    return seats[0] || null;
  }

  function renderSeat(seat, selected) {
    var badgeClass = seatPresenceState(seat);
    var cursorVal = seatEventCursor(seat);
    var cursorUrl = seatEventsUrl(seat);
    var cursorHtml = '';
    if (cursorVal != null) {
      cursorHtml = cursorUrl
        ? '<div class="aiteam-office__task-detail"><a href="' + escapeHtml(cursorUrl) + '">cursor #' + escapeHtml(String(cursorVal)) + '</a></div>'
        : '<div class="aiteam-office__task-detail">cursor #' + escapeHtml(String(cursorVal)) + '</div>';
    }
    return '' +
      '<button type="button" class="aiteam-office__seat' + (selected ? ' is-selected' : '') + '" data-office-seat-select="' + escapeHtml(seat.employee_id || '') + '">' +
      '<div class="aiteam-office__seat-header">' +
      '<span class="aiteam-office__seat-name">' + escapeHtml(seat.display_name || seat.employee_id || '未命名员工') + '</span>' +
      '<span class="aiteam-office__seat-status is-' + escapeHtml(badgeClass) + '">' + escapeHtml(seatStatusLabel(badgeClass)) + '</span>' +
      '</div>' +
      '<div class="aiteam-office__seat-role">' + escapeHtml(seat.role_name || '数字员工') + '</div>' +
      '<div class="aiteam-office__task-bubble">' + escapeHtml(seatTaskPreview(seat)) + '</div>' +
      cursorHtml +
      '</button>';
  }

  function renderSeatDetail(seat) {
    if (!seat) {
      return '<div class="aiteam-office__task-empty">选择一个工位后查看员工详情</div>';
    }
    var status = seatPresenceState(seat);
    var employeeHref = seat.employee_id ? '/admin/employees/' + encodeURIComponent(seat.employee_id) : '#';
    var chatHref = resolveConversationHref(
      seat.conversation_id,
      seat.conversation_type,
      seat.navigation_target
    ) || employeeHref;
    return '' +
      '<div class="aiteam-detail-section">' +
      '<h3>员工详情</h3>' +
      '<div class="aiteam-detail-kv">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">姓名</span><span class="aiteam-shell__meta-value">' + escapeHtml(seat.display_name || seat.employee_id || '未命名员工') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">岗位</span><span class="aiteam-shell__meta-value">' + escapeHtml(seat.role_name || '数字员工') + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">状态</span><span class="aiteam-shell__meta-value">' + escapeHtml(seatStatusLabel(status)) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">当前任务</span><span class="aiteam-shell__meta-value">' + escapeHtml(seatTaskPreview(seat)) + '</span></div>' +
      '</div>' +
      '<div class="aiteam-workbench__quick-links">' +
      '<a href="' + escapeHtml(chatHref) + '">进入对话</a>' +
      '<a href="' + escapeHtml(employeeHref) + '">查看员工详情</a>' +
      '</div>' +
      '</div>';
  }

  function filterTasksBySeat(tasks, seat) {
    if (!seat) return [];
    return (tasks || []).filter(function (item) {
      return String(item && item.employee_id || '') === String(seat.employee_id || '');
    });
  }

  function renderRecentConversation(tasks, seat) {
    var seatTasks = filterTasksBySeat(tasks, seat);
    var latest = seatTasks[0] || null;
    if (!latest) {
      return '<div class="aiteam-office__task-empty">暂无最近对话</div>';
    }
    var href = resolveConversationHref(
      latest.conversation_id,
      latest.conv_type,
      latest.navigation_target
    ) || taskHref(latest);
    return '' +
      '<a class="aiteam-office__task-item" href="' + escapeHtml(href) + '">' +
      '<div class="aiteam-office__task-main">' +
      '<div class="aiteam-office__task-title">' + escapeHtml(latest.preview || latest.title || '最近对话') + '</div>' +
      '<div class="aiteam-office__task-detail">' + escapeHtml(latest.detail || '点击查看最近一轮会话') + '</div>' +
      '</div>' +
      '<div class="aiteam-office__task-meta"><span class="aiteam-office__task-progress">' + escapeHtml(latest.event_ts || '刚刚') + '</span></div>' +
      '</a>';
  }

  function renderHistoryTasks(tasks, seat) {
    var seatTasks = filterTasksBySeat(tasks, seat);
    if (!seatTasks.length) {
      return '<div class="aiteam-office__task-empty">暂无历史任务</div>';
    }
    return seatTasks.map(function (item) {
      return '' +
        '<div class="aiteam-office__task-item">' +
        '<div class="aiteam-office__task-main">' +
        '<div class="aiteam-office__task-title">' + escapeHtml(item.preview || item.title || '历史任务') + '</div>' +
        '<div class="aiteam-office__task-detail">' + escapeHtml(item.detail || '等待更多任务详情') + '</div>' +
        '</div>' +
        '<div class="aiteam-office__task-meta">' +
        '<span class="aiteam-office__task-chip is-' + escapeHtml(String(item.status || 'pending').toLowerCase()) + '">' + escapeHtml(taskStatusLabel(String(item.status || 'pending').toLowerCase(), item.progress)) + '</span>' +
        '<span class="aiteam-office__task-progress">' + escapeHtml(item.event_ts || '刚刚') + '</span>' +
        '</div>' +
        '</div>';
    }).join('');
  }

  function renderTask(item) {
    var progress = Math.max(0, Math.min(100, Number(item.progress) || 0));
    var statusClass = String(item.status || 'pending').toLowerCase();
    var cursorVal = item.latest_event_cursor;
    var cursorHtml = '';
    if (cursorVal != null && item.events_url) {
      cursorHtml = '<a class="aiteam-office__task-progress" href="' + escapeHtml(item.events_url) + '">#' + escapeHtml(String(cursorVal)) + '</a>';
    } else if (cursorVal != null) {
      cursorHtml = '<span class="aiteam-office__task-progress">#' + escapeHtml(String(cursorVal)) + '</span>';
    } else {
      cursorHtml = '<span class="aiteam-office__task-progress">' + escapeHtml(String(progress)) + '%</span>';
    }
    return '' +
      '<a class="aiteam-office__task-item" href="' + escapeHtml(taskHref(item)) + '">' +
      '<div class="aiteam-office__task-main">' +
      '<div class="aiteam-office__task-title">' + escapeHtml(item.title || item.preview || '待处理任务') + '</div>' +
      '<div class="aiteam-office__task-detail">' + escapeHtml((item.employee_display_name || item.employee_name || item.display_name || '系统') + ' · ' + (item.detail || item.preview || '等待更新')) + '</div>' +
      '</div>' +
      '<div class="aiteam-office__task-meta">' +
      '<span class="aiteam-office__task-chip is-' + escapeHtml(statusClass) + '">' + escapeHtml(taskStatusLabel(statusClass, progress)) + '</span>' +
      cursorHtml +
      '</div>' +
      '</a>';
  }

  function renderTaskList(tasks) {
    if (!tasks.length) {
      return '<div class="aiteam-office__task-empty">当前暂无运行中的任务队列</div>';
    }
    return tasks.map(renderTask).join('');
  }

  function renderQueueDigest(feedData) {
    var queue = feedData && feedData.queue ? feedData.queue : {};
    return '' +
      '<div class="aiteam-shell__meta">' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">排队</span><span class="aiteam-shell__meta-value">' + escapeHtml(String(queue.queued || 0)) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">运行中</span><span class="aiteam-shell__meta-value">' + escapeHtml(String(queue.running || 0)) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">待人工</span><span class="aiteam-shell__meta-value">' + escapeHtml(String(queue.waiting_human || 0)) + '</span></div>' +
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">失败</span><span class="aiteam-shell__meta-value">' + escapeHtml(String(queue.failed || 0)) + '</span></div>' +
      '</div>';
  }

  function renderActivityLog(tasks) {
    if (!tasks.length) {
      return '<div class="aiteam-office__task-empty">当前暂无实时活动日志</div>';
    }
    return tasks.slice(0, 5).map(function (item) {
      var actor = item.employee_display_name || item.employee_name || item.display_name || '系统';
      var detail = item.detail || item.preview || '等待更新';
      var eventTs = item.event_ts || '刚刚';
      var href = taskHref(item);
      var tagName = href && href !== '#' ? 'a' : 'div';
      var hrefAttr = tagName === 'a' ? ' href="' + escapeHtml(href) + '"' : '';
      return '' +
        '<' + tagName + ' class="aiteam-office__task-item"' + hrefAttr + '>' +
        '<div class="aiteam-office__task-main">' +
        '<div class="aiteam-office__task-title">' + escapeHtml(actor) + '</div>' +
        '<div class="aiteam-office__task-detail">' + escapeHtml(detail) + '</div>' +
        '</div>' +
        '<div class="aiteam-office__task-meta"><span class="aiteam-office__task-progress">' + escapeHtml(eventTs) + '</span></div>' +
        '</' + tagName + '>';
    }).join('');
  }

  function renderLegend() {
    return '' +
      '<ul class="aiteam-office__legend">' +
      '<li><span class="aiteam-office__legend-dot is-busy"></span> 忙碌：正在执行任务</li>' +
      '<li><span class="aiteam-office__legend-dot is-online"></span> 在线：可立即响应</li>' +
      '<li><span class="aiteam-office__legend-dot is-idle"></span> 空闲：等待新任务</li>' +
      '<li><span class="aiteam-office__legend-dot is-offline"></span> 离线：当前不可用</li>' +
      '</ul>';
  }

  function renderSeamMeta(sceneData, feedData) {
    var sceneCursor = sceneData && sceneData.generated_cursor != null ? sceneData.generated_cursor : '—';
    var feedCursor = feedData && feedData.generated_cursor != null ? feedData.generated_cursor : '—';
    var refreshMs = (feedData && feedData.refresh_hint_ms) || (sceneData && sceneData.refresh_hint_ms) || 0;
    var refreshSec = refreshMs ? (refreshMs / 1000).toFixed(1) : '—';
    return '' +
      '<div class="aiteam-office-seam-meta">' +
      '<span class="aiteam-office-seam-meta__item">场景游标: ' + escapeHtml(String(sceneCursor)) + '</span>' +
      '<span class="aiteam-office-seam-meta__item">活动游标: ' + escapeHtml(String(feedCursor)) + '</span>' +
      '<span class="aiteam-office-seam-meta__item">刷新间隔: ' + escapeHtml(String(refreshSec)) + 's</span>' +
      '</div>';
  }

  function renderOffice(sceneData, feedData, viewportState, selectedSeatId) {
    var summary = sceneData && sceneData.summary ? sceneData.summary : {};
    var seats = Array.isArray(sceneData && sceneData.seats) ? sceneData.seats : [];
    var tasks = Array.isArray(feedData && feedData.items) ? feedData.items : [];
    var view = normalizeViewportState(viewportState);
    var selectedSeat = findSeatById(seats, selectedSeatId);
    return '' +
      '<section class="aiteam-office">' +
      '<div class="aiteam-shell__panel aiteam-office__panel">' +
      '<div class="aiteam-office__toolbar">' +
      '<div>' +
      '<p class="aiteam-shell__panel-kicker">企业前台 · 办公室动态</p>' +
      '<h2 class="aiteam-shell__panel-title">企业办公室</h2>' +
      '<p class="aiteam-shell__panel-body">等距办公室画布、任务队列与实时状态统一映射到 Team Panel 办公视图聚合接口。</p>' +
      '</div>' +
      '<div class="aiteam-office__toolbar-actions">' +
      '<div class="aiteam-office__badge">在线 ' + escapeHtml(String(summary.online_employee_count || 0)) + '</div>' +
      '<div class="aiteam-office__badge">队列 ' + escapeHtml(String(summary.running_task_count || 0)) + '</div>' +
      '<div class="aiteam-office__badge" data-office-viewport-label>' + escapeHtml(viewportScaleLabel(view)) + '</div>' +
      '<button type="button" class="aiteam-office__fullscreen" data-office-zoom-out>缩小</button>' +
      '<button type="button" class="aiteam-office__fullscreen" data-office-zoom-reset>重置视角</button>' +
      '<button type="button" class="aiteam-office__fullscreen" data-office-zoom-in>放大</button>' +
      '<button type="button" class="aiteam-office__fullscreen" data-office-pan-left>←</button>' +
      '<button type="button" class="aiteam-office__fullscreen" data-office-pan-up>↑</button>' +
      '<button type="button" class="aiteam-office__fullscreen" data-office-pan-down>↓</button>' +
      '<button type="button" class="aiteam-office__fullscreen" data-office-pan-right>→</button>' +
      '<button type="button" class="aiteam-office__fullscreen" data-office-fullscreen>全屏查看</button>' +
      '</div>' +
      '</div>' +
      renderSeamMeta(sceneData, feedData) +
      '<div class="aiteam-office__layout">' +
      '<div class="aiteam-office__stage-wrap">' +
      '<div class="aiteam-office__stage" data-office-root style="transform:' + escapeHtml(viewportTransform(view)) + ';transform-origin:center center;">' +
      (seats.length ? seats.map(function (seat) {
        return renderSeat(seat, selectedSeat && String(selectedSeat.employee_id || '') === String(seat.employee_id || ''));
      }).join('') : '<div class="aiteam-office__task-empty">当前暂无工位数据</div>') +
      '</div>' +
      '</div>' +
      '<aside class="aiteam-office__sidebar">' +
      '<div class="aiteam-office__sidebar-card">' +
      renderSeatDetail(selectedSeat) +
      '<div class="aiteam-detail-section">' +
      '<h3>最近对话</h3>' +
      '<div class="aiteam-office__task-list">' + renderRecentConversation(tasks, selectedSeat) + '</div>' +
      '</div>' +
      '<div class="aiteam-detail-section">' +
      '<h3>历史任务</h3>' +
      '<div class="aiteam-office__task-list">' + renderHistoryTasks(tasks, selectedSeat) + '</div>' +
      '</div>' +
      '</div>' +
      '<div class="aiteam-office__sidebar-card">' +
      '<div class="aiteam-office__sidebar-title">任务队列</div>' +
      '<div class="aiteam-office__task-list">' + renderTaskList(tasks) + '</div>' +
      '</div>' +
      '<div class="aiteam-office__sidebar-card">' +
      '<div class="aiteam-office__sidebar-title">队列统计</div>' +
      renderQueueDigest(feedData) +
      '</div>' +
      '<div class="aiteam-office__sidebar-card">' +
      '<div class="aiteam-office__sidebar-title">最新活动</div>' +
      '<div class="aiteam-office__task-list">' + renderActivityLog(tasks) + '</div>' +
      '</div>' +
      '<div class="aiteam-office__sidebar-card">' +
      '<div class="aiteam-office__sidebar-title">状态说明</div>' +
      renderLegend() +
      '</div>' +
      '</aside>' +
      '</div>' +
      '</div>' +
      '</section>';
  }

  function updateFullscreenButton(root, button) {
    if (!root || !button) return;
    var expanded = root.classList && root.classList.contains('is-fullscreen');
    button.textContent = expanded ? '退出全屏' : '全屏查看';
  }

  function toggleFullscreen(root, button) {
    if (!root || !root.classList) return;
    if (root.classList.contains('is-fullscreen')) {
      root.classList.remove('is-fullscreen');
    } else {
      root.classList.add('is-fullscreen');
    }
    updateFullscreenButton(root, button);
  }

  function bindFullscreen(container) {
    if (!container || typeof container.querySelector !== 'function') return;
    var root = container.querySelector('[data-office-root]');
    var button = container.querySelector('[data-office-fullscreen]');
    if (!root || !button || typeof button.addEventListener !== 'function') return;
    updateFullscreenButton(root, button);
    button.addEventListener('click', function () {
      toggleFullscreen(root, button);
    });
  }

  function bindFullscreenShortcut(container) {
    if (typeof document === 'undefined' || !document || typeof document.addEventListener !== 'function') return;
    if (ns.pages.office && ns.pages.office._fullscreenShortcutHandler && typeof document.removeEventListener === 'function') {
      document.removeEventListener('keydown', ns.pages.office._fullscreenShortcutHandler);
    }
    var handler = function (event) {
      var key = String(event && event.key || '').toLowerCase();
      if (key !== 'f') return;
      var target = event && event.target;
      var tagName = String(target && target.tagName || '').toUpperCase();
      if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return;
      if (target && target.isContentEditable) return;
      if (!container || typeof container.querySelector !== 'function') return;
      var root = container.querySelector('[data-office-root]');
      var button = container.querySelector('[data-office-fullscreen]');
      if (!root || !button) return;
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      toggleFullscreen(root, button);
    };
    if (ns.pages.office) {
      ns.pages.office._fullscreenShortcutHandler = handler;
    }
    document.addEventListener('keydown', handler);
  }

  function applyViewportState(container, nextState) {
    if (!container || typeof container.querySelector !== 'function') return normalizeViewportState(nextState);
    var view = normalizeViewportState(nextState);
    container.__aiteamOfficeViewportState = view;
    var root = container.querySelector('[data-office-root]');
    var label = container.querySelector('[data-office-viewport-label]');
    if (root && root.style) {
      root.style.transform = viewportTransform(view);
      root.style.transformOrigin = 'center center';
    }
    if (label) label.textContent = viewportScaleLabel(view);
    return view;
  }

  function zoomViewport(container, delta) {
    var current = normalizeViewportState(container && container.__aiteamOfficeViewportState);
    return applyViewportState(container, {
      scale: current.scale + delta,
      offsetX: current.offsetX,
      offsetY: current.offsetY,
    });
  }

  function panViewport(container, dx, dy) {
    var current = normalizeViewportState(container && container.__aiteamOfficeViewportState);
    return applyViewportState(container, {
      scale: current.scale,
      offsetX: current.offsetX + dx,
      offsetY: current.offsetY + dy,
    });
  }

  function resetViewport(container) {
    return applyViewportState(container, { scale: 1, offsetX: 0, offsetY: 0 });
  }

  function bindViewportControls(container) {
    if (!container || typeof container.querySelector !== 'function') return;
    var zoomIn = container.querySelector('[data-office-zoom-in]');
    var zoomOut = container.querySelector('[data-office-zoom-out]');
    var zoomReset = container.querySelector('[data-office-zoom-reset]');
    var panLeft = container.querySelector('[data-office-pan-left]');
    var panRight = container.querySelector('[data-office-pan-right]');
    var panUp = container.querySelector('[data-office-pan-up]');
    var panDown = container.querySelector('[data-office-pan-down]');
    if (zoomIn && typeof zoomIn.addEventListener === 'function') {
      zoomIn.addEventListener('click', function () { zoomViewport(container, VIEWPORT_SCALE_STEP); });
    }
    if (zoomOut && typeof zoomOut.addEventListener === 'function') {
      zoomOut.addEventListener('click', function () { zoomViewport(container, -VIEWPORT_SCALE_STEP); });
    }
    if (zoomReset && typeof zoomReset.addEventListener === 'function') {
      zoomReset.addEventListener('click', function () { resetViewport(container); });
    }
    if (panLeft && typeof panLeft.addEventListener === 'function') {
      panLeft.addEventListener('click', function () { panViewport(container, -VIEWPORT_PAN_STEP, 0); });
    }
    if (panRight && typeof panRight.addEventListener === 'function') {
      panRight.addEventListener('click', function () { panViewport(container, VIEWPORT_PAN_STEP, 0); });
    }
    if (panUp && typeof panUp.addEventListener === 'function') {
      panUp.addEventListener('click', function () { panViewport(container, 0, -VIEWPORT_PAN_STEP); });
    }
    if (panDown && typeof panDown.addEventListener === 'function') {
      panDown.addEventListener('click', function () { panViewport(container, 0, VIEWPORT_PAN_STEP); });
    }
    applyViewportState(container, container.__aiteamOfficeViewportState || { scale: 1, offsetX: 0, offsetY: 0 });
  }

  function bindSeatSelection(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    var buttons = container.querySelectorAll('[data-office-seat-select]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].addEventListener('click', function () {
        container.__aiteamOfficeSelectedSeatId = this.getAttribute('data-office-seat-select') || '';
        renderOfficeInto(container, container.__aiteamOfficeSceneData || {}, container.__aiteamOfficeFeedData || {});
      });
    }
  }

  function renderOfficeInto(container, sceneData, feedData) {
    var view = normalizeViewportState(container && container.__aiteamOfficeViewportState);
    container.__aiteamOfficeSceneData = sceneData || {};
    container.__aiteamOfficeFeedData = feedData || {};
    var seats = Array.isArray(sceneData && sceneData.seats) ? sceneData.seats : [];
    var selectedSeat = findSeatById(seats, container.__aiteamOfficeSelectedSeatId);
    container.__aiteamOfficeSelectedSeatId = selectedSeat ? (selectedSeat.employee_id || '') : '';
    container.innerHTML = renderOffice(sceneData, feedData, view, container.__aiteamOfficeSelectedSeatId);
    bindFullscreen(container);
    bindFullscreenShortcut(container);
    bindViewportControls(container);
    bindSeatSelection(container);
  }

  function doRefresh(container) {
    if (!container) return;
    Promise.all([
      // Canonical office northbound routes: /api/team/office/scene + /api/team/office/feed
      ns.api.getOfficeScene(),
      ns.api.getOfficeFeed(),
    ]).then(function (results) {
      var sceneResult = results[0];
      var feedResult = results[1];
      if (!sceneResult.ok || !feedResult.ok) return;
      renderOfficeInto(container, sceneResult.data || {}, feedResult.data || {});
    });
  }

  ns.pages.office = {
    _pollTimer: null,

    _stopPolling: function () {
      if (this._pollTimer) {
        clearInterval(this._pollTimer);
        this._pollTimer = null;
      }
    },

    _refreshData: function (container) {
      doRefresh(container);
    },

    _applyViewportState: function (container, nextState) {
      return applyViewportState(container, nextState);
    },

    _zoomViewport: function (container, delta) {
      return zoomViewport(container, delta);
    },

    _panViewport: function (container, dx, dy) {
      return panViewport(container, dx, dy);
    },

    _resetViewport: function (container) {
      return resetViewport(container);
    },

    init: function (container) {
      if (!container) return;
      ns.states.renderLoading(container);
      container.__aiteamOfficeViewportState = normalizeViewportState(container.__aiteamOfficeViewportState);

      var self = this;
      self._stopPolling();

      Promise.all([
        // Canonical office northbound routes: /api/team/office/scene + /api/team/office/feed
        ns.api.getOfficeScene(),
        ns.api.getOfficeFeed(),
      ]).then(function (results) {
        var sceneResult = results[0];
        var feedResult = results[1];
        if (!sceneResult.ok || !feedResult.ok) {
          var errResult = !sceneResult.ok ? sceneResult : feedResult;
          ns.states.handleApiResult(errResult, container, function () {});
          return;
        }

        var sceneData = sceneResult.data || {};
        var feedData = feedResult.data || {};
        renderOfficeInto(container, sceneData, feedData);

        var refreshMs = feedData.refresh_hint_ms || sceneData.refresh_hint_ms;
        if (refreshMs) {
          self._pollTimer = setInterval(function () {
            self._refreshData(container);
          }, refreshMs);
        }
      }).catch(function () {
        ns.states.renderError(container, '办公室数据加载失败');
      });
    },
  };
}(window.aiteam));
