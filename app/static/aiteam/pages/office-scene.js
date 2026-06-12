window.aiteam = window.aiteam || {};

(function registerOfficeScenePage(ns) {
  ns.pages = ns.pages || {};

  var PREVIEW_SCENE = {
    summary: {
      online_employee_count: 4,
      running_task_count: 2,
      mode_label: '预览模式 · 示例数据',
    },
    seats: [
      {
        employee_id: 'preview_rex',
        display_name: 'Rex',
        role_name: '代码工程师',
        presence: 'busy',
        current_task: '执行自动化回归',
        conversation_id: 'preview-conv-rex',
      },
      {
        employee_id: 'preview_orion',
        display_name: 'Orion',
        role_name: '研究员',
        presence: 'online',
        current_task: '查阅文档与方案',
        conversation_id: 'preview-conv-orion',
      },
      {
        employee_id: 'preview_nova',
        display_name: 'Nova',
        role_name: '数据科学家',
        presence: 'idle',
        current_task: '等待新任务',
      },
      {
        employee_id: 'preview_iris',
        display_name: 'Iris',
        role_name: '内容创作师',
        presence: 'offline',
        current_task: '当前未上线',
      },
    ],
  };

  var PREVIEW_FEED = {
    items: [
      {
        employee_id: 'preview_rex',
        employee_name: 'Rex',
        title: '执行自动化回归',
        detail: '回归测试与质量检查',
        status: 'running',
        progress: 62,
      },
      {
        employee_id: 'preview_orion',
        employee_name: 'Orion',
        title: '整理方案文档',
        detail: '提炼 P09 页面交互',
        status: 'running',
        progress: 34,
      },
      {
        employee_id: 'preview_nova',
        employee_name: 'Nova',
        title: '等待新队列',
        detail: '当前暂无排队任务',
        status: 'pending',
        progress: 0,
      },
    ],
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function seatStatusLabel(value) {
    if (value === 'busy' || value === 'running' || value === 'working') return '忙碌';
    if (value === 'online' || value === 'active') return '在线';
    if (value === 'offline' || value === 'paused') return '离线';
    return '空闲';
  }

  function taskStatusLabel(value, progress) {
    if (value === 'done' || value === 'completed' || Number(progress) >= 100) return '已完成';
    if (value === 'running' || value === 'busy') return '进行中';
    return '待处理';
  }

  function taskHref(item) {
    if (item && item.conversation_id) return '/app/chat/' + encodeURIComponent(item.conversation_id);
    if (item && item.employee_id) return '/admin/employees/' + encodeURIComponent(item.employee_id);
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
    return !!(
      feedResult &&
      feedResult.ok &&
      feed &&
      Array.isArray(feed.items)
    );
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
      },
      feed: {
        items: feed.items,
      },
    };
  }

  function renderSeat(seat) {
    var href = taskHref(seat);
    var badgeClass = String(seat.presence || 'idle').toLowerCase();
    return '' +
      '<a class="aiteam-office__seat" href="' + escapeHtml(href) + '">' +
      '<div class="aiteam-office__seat-header">' +
      '<span class="aiteam-office__seat-name">' + escapeHtml(seat.display_name || seat.employee_id || '未命名员工') + '</span>' +
      '<span class="aiteam-office__seat-status is-' + escapeHtml(badgeClass) + '">' + escapeHtml(seatStatusLabel(badgeClass)) + '</span>' +
      '</div>' +
      '<div class="aiteam-office__seat-role">' + escapeHtml(seat.role_name || '数字员工') + '</div>' +
      '<div class="aiteam-office__task-bubble">' + escapeHtml(seat.current_task || '等待任务') + '</div>' +
      '</a>';
  }

  function renderTask(item) {
    var progress = Math.max(0, Math.min(100, Number(item.progress) || 0));
    var statusClass = String(item.status || 'pending').toLowerCase();
    return '' +
      '<a class="aiteam-office__task-item" href="' + escapeHtml(taskHref(item)) + '">' +
      '<div class="aiteam-office__task-main">' +
      '<div class="aiteam-office__task-title">' + escapeHtml(item.title || '待处理任务') + '</div>' +
      '<div class="aiteam-office__task-detail">' + escapeHtml((item.employee_name || item.display_name || '系统') + ' · ' + (item.detail || '等待更新')) + '</div>' +
      '</div>' +
      '<div class="aiteam-office__task-meta">' +
      '<span class="aiteam-office__task-chip is-' + escapeHtml(statusClass) + '">' + escapeHtml(taskStatusLabel(statusClass, progress)) + '</span>' +
      '<span class="aiteam-office__task-progress">' + escapeHtml(String(progress)) + '%</span>' +
      '</div>' +
      '</a>';
  }

  function renderTaskList(tasks) {
    if (!tasks.length) {
      return '<div class="aiteam-office__task-empty">当前暂无运行中的任务队列</div>';
    }
    return tasks.map(renderTask).join('');
  }

  function renderScene(payload) {
    var summary = payload.scene.summary || {};
    var seats = payload.scene.seats || [];
    var tasks = payload.feed.items || [];
    var toolbarLabel = payload.preview
      ? (summary.mode_label || '预览模式 · 示例数据')
      : (summary.mode_label || '实时视图');
    return '' +
      '<section class="aiteam-office' + (payload.preview ? ' is-preview' : '') + '">' +
      '<div class="aiteam-shell__panel aiteam-office__panel">' +
      '<div class="aiteam-office__toolbar">' +
      '<div>' +
      '<p class="aiteam-shell__panel-kicker">企业前台 · 办公室动态</p>' +
      '<h2 class="aiteam-shell__panel-title">办公室动态</h2>' +
      '<p class="aiteam-shell__panel-body">' + escapeHtml(toolbarLabel) + '</p>' +
      '</div>' +
      '<div class="aiteam-office__toolbar-actions">' +
      '<div class="aiteam-office__badge">在线 ' + escapeHtml(summary.online_employee_count || 0) + '</div>' +
      '<div class="aiteam-office__badge">队列 ' + escapeHtml(summary.running_task_count || 0) + '</div>' +
      '<button type="button" class="aiteam-office__fullscreen" data-office-fullscreen>全屏查看</button>' +
      '</div>' +
      '</div>' +
      '<div class="aiteam-office__layout">' +
      '<div class="aiteam-office__stage-wrap">' +
      '<div class="aiteam-office__stage" data-office-root>' + seats.map(renderSeat).join('') + '</div>' +
      '</div>' +
      '<aside class="aiteam-office__sidebar">' +
      '<div class="aiteam-office__sidebar-card">' +
      '<div class="aiteam-office__sidebar-title">任务队列</div>' +
      '<div class="aiteam-office__task-list">' + renderTaskList(tasks) + '</div>' +
      '</div>' +
      '<div class="aiteam-office__sidebar-card">' +
      '<div class="aiteam-office__sidebar-title">状态说明</div>' +
      '<ul class="aiteam-office__legend">' +
      '<li><span class="aiteam-office__legend-dot is-busy"></span> 忙碌：正在执行任务</li>' +
      '<li><span class="aiteam-office__legend-dot is-online"></span> 在线：可立即响应</li>' +
      '<li><span class="aiteam-office__legend-dot is-idle"></span> 空闲：等待新任务</li>' +
      '<li><span class="aiteam-office__legend-dot is-offline"></span> 离线：当前不可用</li>' +
      '</ul>' +
      '</div>' +
      '</aside>' +
      '</div>' +
      '</div>' +
      '</section>';
  }

  function updateFullscreenButton(root, button) {
    if (!root || !button) return;
    button.textContent = root.classList && root.classList.contains('is-fullscreen') ? '退出全屏' : '全屏查看';
  }

  function toggleFullscreen(root, button) {
    if (!root) return;
    var entering = !(root.classList && root.classList.contains('is-fullscreen'));
    if (root.classList) {
      if (entering) {
        root.classList.add('is-fullscreen');
      } else {
        root.classList.remove('is-fullscreen');
      }
    }
    updateFullscreenButton(root, button);
    if (typeof document === 'undefined') return;
    if (entering && root.requestFullscreen) {
      Promise.resolve(root.requestFullscreen()).catch(function () {});
      return;
    }
    if (!entering && document.fullscreenElement && document.exitFullscreen) {
      Promise.resolve(document.exitFullscreen()).catch(function () {});
    }
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

  ns.pages.officeScene = {
    toggleFullscreen: toggleFullscreen,

    init: function (container) {
      if (!container) return;
      container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载办公室动态...</p></div>';
      Promise.all([
        ns.api.getOfficeScene(),
        ns.api.getOfficeFeed(),
      ]).then(function (results) {
        var payload = normalizeScene(results[0], results[1]);
        container.innerHTML = renderScene(payload);
        bindFullscreen(container);
      }).catch(function () {
        container.innerHTML = renderScene({
          preview: true,
          scene: PREVIEW_SCENE,
          feed: PREVIEW_FEED,
        });
        bindFullscreen(container);
      });
    },
  };
}(window.aiteam));
