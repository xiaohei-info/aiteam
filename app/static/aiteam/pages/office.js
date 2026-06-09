window.aiteam = window.aiteam || {};

(function registerOfficePage(ns) {
  ns.pages = ns.pages || {};
  var OFFICE_SCENE_PATH = '/api/team/office/scene';
  var OFFICE_FEED_PATH = '/api/team/office/feed';

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

  function taskHref(item) {
    if (item && item.conversation_id) return '/app/chat/' + encodeURIComponent(item.conversation_id);
    if (item && item.employee_id) return '/admin/employees/' + encodeURIComponent(item.employee_id);
    return '#';
  }

  function renderSeat(seat) {
    var href = taskHref(seat);
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
      '<a class="aiteam-office__seat" href="' + escapeHtml(href) + '">' +
      '<div class="aiteam-office__seat-header">' +
      '<span class="aiteam-office__seat-name">' + escapeHtml(seat.display_name || seat.employee_id || '未命名员工') + '</span>' +
      '<span class="aiteam-office__seat-status is-' + escapeHtml(badgeClass) + '">' + escapeHtml(seatStatusLabel(badgeClass)) + '</span>' +
      '</div>' +
      '<div class="aiteam-office__seat-role">' + escapeHtml(seat.role_name || '数字员工') + '</div>' +
      '<div class="aiteam-office__task-bubble">' + escapeHtml(seatTaskPreview(seat)) + '</div>' +
      cursorHtml +
      '</a>';
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

  function renderOffice(sceneData, feedData) {
    var summary = sceneData && sceneData.summary ? sceneData.summary : {};
    var seats = Array.isArray(sceneData && sceneData.seats) ? sceneData.seats : [];
    var tasks = Array.isArray(feedData && feedData.items) ? feedData.items : [];
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
      '<button type="button" class="aiteam-office__fullscreen" data-office-fullscreen>全屏查看</button>' +
      '</div>' +
      '</div>' +
      renderSeamMeta(sceneData, feedData) +
      '<div class="aiteam-office__layout">' +
      '<div class="aiteam-office__stage-wrap">' +
      '<div class="aiteam-office__stage" data-office-root>' +
      (seats.length ? seats.map(renderSeat).join('') : '<div class="aiteam-office__task-empty">当前暂无工位数据</div>') +
      '</div>' +
      '</div>' +
      '<aside class="aiteam-office__sidebar">' +
      '<div class="aiteam-office__sidebar-card">' +
      '<div class="aiteam-office__sidebar-title">任务队列</div>' +
      '<div class="aiteam-office__task-list">' + renderTaskList(tasks) + '</div>' +
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

  function bindFullscreen(container) {
    if (!container || typeof container.querySelector !== 'function') return;
    var root = container.querySelector('[data-office-root]');
    var button = container.querySelector('[data-office-fullscreen]');
    if (!root || !button || typeof button.addEventListener !== 'function') return;
    updateFullscreenButton(root, button);
    button.addEventListener('click', function () {
      if (!root.classList) return;
      if (root.classList.contains('is-fullscreen')) {
        root.classList.remove('is-fullscreen');
      } else {
        root.classList.add('is-fullscreen');
      }
      updateFullscreenButton(root, button);
    });
  }

  function renderOfficeInto(container, sceneData, feedData) {
    container.innerHTML = renderOffice(sceneData, feedData);
    bindFullscreen(container);
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

    init: function (container) {
      if (!container) return;
      ns.states.renderLoading(container);

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
