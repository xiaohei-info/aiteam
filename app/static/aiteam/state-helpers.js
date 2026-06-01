window.aiteam = window.aiteam || {};
var aiteam = window.aiteam;

aiteam.states = {
  renderEmpty: function renderEmpty(container, message) {
    container.innerHTML = '<div class="aiteam-state aiteam-state-empty"><p>' + (message || '暂无数据') + '</p></div>';
  },

  renderError: function renderError(container, message) {
    container.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>' + (message || '加载失败，请稍后重试') + '</p></div>';
  },

  renderPermissionDenied: function renderPermissionDenied(container) {
    container.innerHTML = '<div class="aiteam-state aiteam-state-denied"><p>您没有权限访问此内容</p></div>';
  },

  renderLoading: function renderLoading(container) {
    container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载中...</p></div>';
  },

  handleApiResult: function handleApiResult(result, container, onSuccess) {
    if (!result || !result.ok) {
      if (result && result.status === 403) {
        this.renderPermissionDenied(container);
        return;
      }
      var status = result && typeof result.status !== 'undefined' ? result.status : 0;
      var message = result && result.error ? result.error : '请求失败 (' + status + ')';
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
