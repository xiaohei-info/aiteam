window.aiteam = window.aiteam || {};
var aiteam = window.aiteam;

(function registerStateHelpers(ns) {
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function extractErrorMeta(result) {
    var payload = result && result.data && typeof result.data === 'object' ? result.data : null;
    var errorObj = payload && payload.error && typeof payload.error === 'object' ? payload.error : null;
    return {
      code: (errorObj && errorObj.code) || (payload && typeof payload.error === 'string' ? payload.error : ''),
      message: (errorObj && errorObj.message) || (result && result.error) || '',
      retryable: !!(errorObj && errorObj.retryable),
    };
  }

  ns.util = ns.util || {};
  ns.util.escapeHtml = escapeHtml;

  aiteam.states = {
    renderEmpty: function renderEmpty(container, message, actionHtml) {
      container.innerHTML = '<div class="aiteam-state aiteam-state-empty"><p>' + escapeHtml(message || '暂无数据') + '</p>' + (actionHtml || '') + '</div>';
    },

    renderError: function renderError(container, message, retryHtml) {
      container.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>' + escapeHtml(message || '加载失败，请稍后重试') + '</p>' + (retryHtml || '') + '</div>';
    },

    renderPermissionDenied: function renderPermissionDenied(container, message) {
      container.innerHTML = '<div class="aiteam-state aiteam-state-denied"><p>' + escapeHtml(message || '您没有权限访问此内容') + '</p></div>';
    },

    renderLoading: function renderLoading(container, message) {
      container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>' + escapeHtml(message || '加载中...') + '</p></div>';
    },

    renderInfo: function renderInfo(container, message) {
      container.innerHTML = '<div class="aiteam-state aiteam-state-info"><p>' + escapeHtml(message || '') + '</p></div>';
    },

    handleApiResult: function handleApiResult(result, container, onSuccess) {
      if (!result || !result.ok) {
        var meta = extractErrorMeta(result);
        if (result && result.status === 403 || meta.code === 'PERMISSION_DENIED') {
          this.renderPermissionDenied(container, meta.code === 'PERMISSION_DENIED' && meta.message ? meta.message : '您没有权限访问此内容');
          return;
        }
        var status = result && typeof result.status !== 'undefined' ? result.status : 0;
        var message = meta.message || '请求失败 (' + status + ')';
        this.renderError(container, message);
        return;
      }

      if (!result.data || (Array.isArray(result.data) && result.data.length === 0)) {
        this.renderEmpty(container);
        return;
      }

      if (onSuccess) {
        onSuccess(result.data);
      }
    }
  };
}(window.aiteam));
