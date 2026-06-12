// system-health.js — L4-D2: System Admin health/finance with governance UX
window.aiteam = window.aiteam || {};

(function registerSystemHealthPage(ns) {
  ns.pages = ns.pages || {};

  function _renderPermissionDenied(container) {
    if (ns.states && ns.states.renderPermissionDenied) {
      ns.states.renderPermissionDenied(container);
    } else {
      container.innerHTML = '<div class="aiteam-state aiteam-state-denied"><p>您没有权限访问此内容</p></div>';
    }
  }

  ns.pages.systemHealth = {
    init: function (container) {
      if (!container) return;

      var role = ns.role ? ns.role.getActiveRole() : '';

      // System pages only accessible to system_admin or system_operator
      if (role && ns.role) {
        var isSystemRole = ns.role.hasPermission(role, 'system_read');
        if (!isSystemRole) {
          _renderPermissionDenied(container);
          return;
        }
      }

      if (ns.states && ns.states.renderLoading) {
        ns.states.renderLoading(container);
      } else {
        container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载系统健康数据...</p></div>';
      }

      function formatPercent(value) {
        var num = Number(value);
        return isFinite(num) ? num.toFixed(1) + '%' : '—';
      }

      function formatGb(value) {
        var num = Number(value);
        return isFinite(num) ? (num / (1024 * 1024 * 1024)).toFixed(1) + ' GB' : '—';
      }

      function metricCard(label, percentText, detailText) {
        return '<div class="aiteam-shell__meta-card">' +
          '<span class="aiteam-shell__meta-label">' + label + '</span>' +
          '<span class="aiteam-shell__meta-value">' + percentText + '</span>' +
          (detailText ? '<span class="aiteam-inline-note">' + detailText + '</span>' : '') +
          '</div>';
      }

      ns.api.get('/api/system-admin/health').then(function (result) {
        if (!result.ok) {
          if (result.status === 501) {
            container.innerHTML =
              '<div class="aiteam-shell__panel">' +
              '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
              '<h2 class="aiteam-shell__panel-title">系统健康</h2>' +
              '<p class="aiteam-shell__panel-body">系统健康数据暂时不可用，请稍后刷新重试。</p>' +
              '</div>';
            return;
          }
          if (ns.states && ns.states.handleApiResult) {
            ns.states.handleApiResult(result, container, function () {});
          } else {
            container.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>⚠ 系统健康数据加载失败</p></div>';
          }
          return;
        }
        var data = result.data || {};
        var cpu = data.cpu || {};
        var memory = data.memory || {};
        var disk = data.disk || {};
        var errors = Array.isArray(data.errors) ? data.errors : [];
        var healthy = data.available !== false && data.status === 'ok' && !errors.length;
        var statusBanner = healthy
          ? '<div class="aiteam-alert aiteam-alert-success">平台运行正常</div>'
          : '<div class="aiteam-alert aiteam-alert-warning">平台存在异常：' + (errors.join('；') || '状态未知') + '</div>';
        container.innerHTML =
          '<div class="aiteam-shell__panel">' +
          '<p class="aiteam-shell__panel-kicker">系统后台</p>' +
          '<h2 class="aiteam-shell__panel-title">系统健康</h2>' +
          '<p class="aiteam-shell__panel-body">查看平台基础设施的实时健康状态。</p>' +
          statusBanner +
          '<div class="aiteam-shell__meta">' +
          metricCard('CPU 使用率', formatPercent(cpu.percent), '') +
          metricCard('内存使用率', formatPercent(memory.percent), formatGb(memory.used_bytes) + ' / ' + formatGb(memory.total_bytes)) +
          metricCard('磁盘使用率', formatPercent(disk.percent), formatGb(disk.used_bytes) + ' / ' + formatGb(disk.total_bytes)) +
          '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">检查时间</span><span class="aiteam-shell__meta-value">' + String(data.checked_at || '').slice(0, 19).replace('T', ' ') + '</span></div>' +
          '</div>' +
          '</div>';
      });
    },
  };
}(window.aiteam));
