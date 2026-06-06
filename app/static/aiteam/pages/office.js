window.aiteam = window.aiteam || {};

(function registerOfficePage(ns) {
  ns.pages = ns.pages || {};

  var PRESENCE_BADGE = {
    idle: 'aiteam-badge--idle',
    online: 'aiteam-badge--online',
    busy: 'aiteam-badge--busy',
    streaming: 'aiteam-badge--streaming',
    queued: 'aiteam-badge--queued',
    waiting_reply: 'aiteam-badge--waiting_reply',
    offline: 'aiteam-badge--offline',
    paused: 'aiteam-badge--paused',
    provisioning: 'aiteam-badge--provisioning',
    done: 'aiteam-badge--done',
    failed: 'aiteam-badge--failed',
  };

  var PRESENCE_LABEL = {
    idle: '空闲',
    busy: '忙碌',
    streaming: '流式',
    queued: '排队',
    waiting_reply: '待回复',
    offline: '离线',
    paused: '暂停',
    provisioning: '部署中',
    done: '完成',
    failed: '失败',
  };

  var RUN_BADGE = {
    queued: 'aiteam-badge--queued',
    running: 'aiteam-badge--busy',
    streaming: 'aiteam-badge--streaming',
    waiting_human: 'aiteam-badge--waiting_reply',
    completed: 'aiteam-badge--done',
    succeeded: 'aiteam-badge--done',
    failed: 'aiteam-badge--failed',
    error: 'aiteam-badge--failed',
  };

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderSeatCard(seat) {
    var state = seat.presence && seat.presence.state ? seat.presence.state : 'idle';
    var badgeClass = PRESENCE_BADGE[state] || 'aiteam-badge--idle';
    var stateLabel = PRESENCE_LABEL[state] || state;
    var taskPreview = seat.presence && seat.presence.current_task ? escapeHtml(seat.presence.current_task) : '';
    var cursorHtml = '';
    if (seat.presence && seat.presence.latest_event_cursor != null) {
      var cursorVal = seat.presence.latest_event_cursor;
      var eventsUrl = seat.presence.events_url;
      if (eventsUrl) {
        cursorHtml = '<a class="aiteam-seat-card__cursor-link" href="' + escapeHtml(eventsUrl) + '">cursor #' + cursorVal + '</a>';
      } else {
        cursorHtml = '<span class="aiteam-seat-card__cursor">cursor #' + cursorVal + '</span>';
      }
    }
    return (
      '<div class="aiteam-seat-card">' +
      '<h4 class="aiteam-seat-card__name">' + escapeHtml(seat.display_name || seat.employee_id || '—') + '</h4>' +
      '<p class="aiteam-seat-card__role">' + escapeHtml(seat.role_name || '') + '</p>' +
      '<span class="aiteam-seat-card__presence aiteam-badge ' + badgeClass + '">' + stateLabel + '</span>' +
      (taskPreview ? '<p class="aiteam-seat-card__task">' + taskPreview + '</p>' : '') +
      (cursorHtml ? '<p class="aiteam-seat-card__cursor-row">' + cursorHtml + '</p>' : '') +
      '</div>'
    );
  }

  function renderFeedItem(item) {
    var badgeClass = RUN_BADGE[item.status] || 'aiteam-badge--idle';
    var statusLabel = item.status || 'unknown';
    var timeStr = item.event_ts ? item.event_ts.substring(11, 19) : '';
    var cursorHtml = '';
    if (item.latest_event_cursor != null && item.events_url) {
      cursorHtml = '<a class="aiteam-feed-item__cursor-link" href="' + escapeHtml(item.events_url) + '">#' + item.latest_event_cursor + '</a>';
    }
    return (
      '<div class="aiteam-feed-item">' +
      '<span class="aiteam-feed-item__employee">' + escapeHtml(item.employee_display_name || item.employee_id || '—') + '</span>' +
      '<span class="aiteam-badge ' + badgeClass + '">' + statusLabel + '</span>' +
      '<span class="aiteam-feed-item__preview">' + escapeHtml(item.preview || '') + '</span>' +
      '<span class="aiteam-feed-item__time">' + escapeHtml(timeStr) + '</span>' +
      (cursorHtml ? '<span class="aiteam-feed-item__cursor">' + cursorHtml + '</span>' : '') +
      '</div>'
    );
  }

  function renderSummary(stats) {
    return (
      '<div class="aiteam-office-summary">' +
      '<div class="aiteam-office-stat"><div class="aiteam-office-stat__value">' + (stats.online_employee_count || 0) + '</div><div class="aiteam-office-stat__label">在线员工</div></div>' +
      '<div class="aiteam-office-stat"><div class="aiteam-office-stat__value">' + (stats.busy_employee_count || 0) + '</div><div class="aiteam-office-stat__label">忙碌员工</div></div>' +
      '<div class="aiteam-office-stat"><div class="aiteam-office-stat__value">' + (stats.running_task_count || 0) + '</div><div class="aiteam-office-stat__label">运行中任务</div></div>' +
      '<div class="aiteam-office-stat"><div class="aiteam-office-stat__value">' + (stats.queue_depth || 0) + '</div><div class="aiteam-office-stat__label">排队任务</div></div>' +
      '<div class="aiteam-office-stat"><div class="aiteam-office-stat__value">' + (stats.waiting_reply_count || 0) + '</div><div class="aiteam-office-stat__label">待回复</div></div>' +
      '</div>'
    );
  }

  function renderScene(scene) {
    var summaryHtml = scene.summary ? renderSummary(scene.summary) : '';
    var seats = scene.seats || [];
    var seatsHtml = seats.length
      ? '<div class="aiteam-office-seats">' + seats.map(renderSeatCard).join('') + '</div>'
      : '<div class="aiteam-state aiteam-state-empty"><p>暂无工位数据</p></div>';
    return summaryHtml +
      '<h3 class="aiteam-section-title">工位状态</h3>' +
      seatsHtml;
  }

  function renderFeed(feed) {
    var items = feed.items || [];
    var queue = feed.queue || {};
    var queueSummary = (queue.queued || 0) + (queue.running || 0) + (queue.waiting_human || 0) + (queue.failed || 0) > 0
      ? '<p style="font-size:12px;color:#94a3b8;margin-bottom:12px;">队列: 排队 ' + (queue.queued || 0) + ' / 运行中 ' + (queue.running || 0) + ' / 待回复 ' + (queue.waiting_human || 0) + ' / 失败 ' + (queue.failed || 0) + '</p>'
      : '';
    var feedHtml = items.length
      ? '<div class="aiteam-feed-list">' + items.map(renderFeedItem).join('') + '</div>'
      : '<div class="aiteam-state aiteam-state-empty"><p>暂无活动记录</p></div>';
    return '<div class="aiteam-section-spacer"></div>' +
      '<h3 class="aiteam-section-title">活动流</h3>' +
      queueSummary +
      feedHtml;
  }

  function renderSeamMeta(sceneData, feedData) {
    var sceneCursor = (sceneData && sceneData.generated_cursor != null) ? sceneData.generated_cursor : '—';
    var feedCursor = (feedData && feedData.generated_cursor != null) ? feedData.generated_cursor : '—';
    var refreshMs = (feedData && feedData.refresh_hint_ms) || (sceneData && sceneData.refresh_hint_ms) || 0;
    var refreshSec = refreshMs ? (refreshMs / 1000).toFixed(1) : '—';
    return (
      '<div class="aiteam-office-seam-meta">' +
      '<span class="aiteam-office-seam-meta__item">场景游标: ' + sceneCursor + '</span>' +
      '<span class="aiteam-office-seam-meta__item">活动游标: ' + feedCursor + '</span>' +
      '<span class="aiteam-office-seam-meta__item">刷新间隔: ' + refreshSec + 's</span>' +
      '</div>'
    );
  }

  function doRefresh(container) {
    if (!container) return;
    Promise.all([
      ns.api.getOfficeScene(),
      ns.api.getOfficeFeed(),
    ]).then(function (results) {
      var sceneResult = results[0];
      var feedResult = results[1];
      if (!sceneResult.ok || !feedResult.ok) return;

      var sceneData = sceneResult.data;
      var feedData = feedResult.data;
      container.innerHTML =
        '<div class="aiteam-shell__panel">' +
        '<p class="aiteam-shell__panel-kicker">企业前台</p>' +
        '<h2 class="aiteam-shell__panel-title">办公室</h2>' +
        '<p class="aiteam-shell__panel-body">通过 /api/team/office/scene 与 /api/team/office/feed 消费实时办公视图。</p>' +
        renderSeamMeta(sceneData, feedData) +
        renderScene(sceneData) +
        renderFeed(feedData) +
        '</div>';
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

        var sceneData = sceneResult.data;
        var feedData = feedResult.data;

        container.innerHTML =
          '<div class="aiteam-shell__panel">' +
          '<p class="aiteam-shell__panel-kicker">企业前台</p>' +
          '<h2 class="aiteam-shell__panel-title">办公室</h2>' +
          '<p class="aiteam-shell__panel-body">通过 /api/team/office/scene 与 /api/team/office/feed 消费实时办公视图。</p>' +
          renderSeamMeta(sceneData, feedData) +
          renderScene(sceneData) +
          renderFeed(feedData) +
          '</div>';

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
