window.aiteam = window.aiteam || {};

(function registerAdminConnectorsPage(ns) {
  ns.pages = ns.pages || {};

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function stringValue(value, fallback) {
    if (value == null || value === '') return fallback || '';
    return String(value);
  }

  function normalizeItems(payload) {
    if (!payload) return [];
    if (Array.isArray(payload.items)) return payload.items.slice();
    if (Array.isArray(payload.connectors)) return payload.connectors.slice();
    if (Array.isArray(payload.catalog)) return payload.catalog.slice();
    if (Array.isArray(payload)) return payload.slice();
    return [];
  }

  function isSecretKey(key) {
    var lower = String(key || '').toLowerCase();
    return lower.indexOf('secret') !== -1 ||
      lower.indexOf('token') !== -1 ||
      lower.indexOf('password') !== -1 ||
      lower.indexOf('credential') !== -1 ||
      lower.indexOf('api_key') !== -1 ||
      lower.indexOf('apikey') !== -1;
  }

  function maskConfig(config) {
    var source = config && typeof config === 'object' ? config : {};
    var parts = [];
    Object.keys(source).forEach(function (key) {
      var value = source[key];
      if (isSecretKey(key)) {
        parts.push(key + ': ****');
      } else if (value && typeof value === 'object') {
        parts.push(key + ': ' + JSON.stringify(maskNested(value)));
      } else {
        parts.push(key + ': ' + String(value));
      }
    });
    return parts.join(' · ');
  }

  function maskNested(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value.map(maskNested);
    }
    var result = {};
    Object.keys(value).forEach(function (key) {
      if (isSecretKey(key)) result[key] = '****';
      else result[key] = maskNested(value[key]);
    });
    return result;
  }

  function normalizeConnector(item) {
    var grants = item && (item.grants || item.employee_grants || item.granted_employee_ids) || [];
    var status = stringValue(item && (item.status || item.health_status), 'draft');
    var config = item && (item.config || item.config_json || item.connection_config) || {};
    var credentialRef = stringValue(item && item.credential_ref, '');
    return {
      connector_id: stringValue(item && (item.connector_id || item.id), ''),
      name: stringValue(item && item.name, '未命名连接器'),
      provider: stringValue(item && (item.provider || item.provider_code), 'custom'),
      type: stringValue(item && (item.type || item.connector_type || item.auth_type), 'custom_mcp'),
      status: status,
      health_status: stringValue(item && item.health_status, status),
      credential_ref: credentialRef,
      credential_mask: credentialRef ? '****' : '未配置',
      config_summary: maskConfig(config),
      grants: Array.isArray(grants) ? grants.slice() : [],
      test_log: stringValue(item && (item.test_log || item.last_test_log), ''),
      last_test_at: stringValue(item && item.last_test_at, ''),
    };
  }

  function apiErrorMessage(result) {
    if (result && result.status === 403) return '您没有权限访问连接器配置';
    if (result && result.status === 404) return '连接器接口尚未开放';
    if (result && result.status === 501) return '连接器接口尚未实现';
    if (result && result.error) return result.error;
    if (result && typeof result.status !== 'undefined') return '请求失败 (' + result.status + ')';
    return '网络请求失败';
  }

  function renderPermissionDenied(container) {
    if (ns.states && ns.states.renderPermissionDenied) {
      ns.states.renderPermissionDenied(container);
    } else {
      container.innerHTML = '<div class="aiteam-state aiteam-state-denied"><p>您没有权限访问此内容</p></div>';
    }
  }

  function createController(container) {
    var state = {
      items: [],
      notice: '',
      loadState: 'loading',
      pendingConnectorId: '',
      pendingAction: '',
    };

    function setNotice(message) {
      state.notice = message || '';
    }

    function renderNotReady(result) {
      container.innerHTML =
        '<div class="aiteam-shell__panel">' +
        '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
        '<h2 class="aiteam-shell__panel-title">连接器中心</h2>' +
        '<p class="aiteam-shell__panel-body">B05 连接器管理页已对接 `/api/team/connectors`、`POST /api/team/connectors/{id}/test` 与 `PATCH /api/team/connectors/{id}/grants`。当前后端尚未开放完整 CRUD，因此前端保留安全降级与字段说明，不伪造凭据状态。</p>' +
        '<div class="aiteam-shell__meta">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">安全约束</span><span class="aiteam-shell__meta-value">credential_ref 仅显示为引用，不暴露明文</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">当前状态</span><span class="aiteam-shell__meta-value">' + esc(apiErrorMessage(result)) + '</span></div>' +
        '</div>' +
        '</div>';
    }

    function renderCard(item) {
      var actionDisabled = state.pendingConnectorId === item.connector_id ? ' disabled' : '';
      var grants = item.grants.length ? item.grants.join(', ') : '暂无授权员工';
      var lastTest = item.last_test_at ? '最近检测：' + esc(item.last_test_at) : '尚未执行连接测试';
      var logMarkup = item.test_log
        ? '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">测试日志</span><span class="aiteam-shell__meta-value">' + esc(item.test_log) + '</span></div>'
        : '';
      return '<li class="aiteam-skill-card">' +
        '<div class="aiteam-skill-card__title">' + esc(item.name) + '</div>' +
        '<div class="aiteam-skill-card__meta">Provider：' + esc(item.provider) + ' · 类型：' + esc(item.type) + '</div>' +
        '<div class="aiteam-skill-card__meta">健康状态：' + esc(item.health_status) + ' · 连接状态：' + esc(item.status) + '</div>' +
        '<div class="aiteam-skill-card__meta">凭据引用：' + esc(item.credential_mask) + '（引用托管，不回显明文）</div>' +
        '<div class="aiteam-skill-card__meta">配置摘要：' + esc(item.config_summary || '暂无自定义配置') + '</div>' +
        '<div class="aiteam-skill-card__meta">员工可见性：' + esc(grants) + '</div>' +
        '<div class="aiteam-skill-card__meta">' + lastTest + '</div>' +
        '<div class="aiteam-shell__meta">' + logMarkup + '</div>' +
        '<div class="aiteam-skill-card__actions">' +
        '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="connector-test" data-connector-id="' + esc(item.connector_id) + '"' + actionDisabled + '>测试连接</button>' +
        '<button type="button" class="aiteam-btn" data-role="connector-grants" data-connector-id="' + esc(item.connector_id) + '"' + actionDisabled + '>设置员工授权</button>' +
        '</div>' +
        '</li>';
    }

    function bindEvents() {
      if (!container || !container.querySelectorAll) return;
      var createForm = container.querySelector('[data-role="connector-create-form"]');
      if (createForm && createForm.addEventListener) {
        createForm.addEventListener('submit', function (event) {
          if (event && event.preventDefault) event.preventDefault();
          var nameInput = container.querySelector('[data-role="connector-name"]');
          var providerInput = container.querySelector('[data-role="connector-provider"]');
          var typeInput = container.querySelector('[data-role="connector-type"]');
          var tenantInput = container.querySelector('[data-role="connector-tenant-hint"]');
          var payload = {
            name: stringValue(nameInput && nameInput.value, '').trim(),
            provider: stringValue(providerInput && providerInput.value, 'custom').trim(),
            type: stringValue(typeInput && typeInput.value, 'custom_mcp').trim(),
            config: {
              tenant_hint: stringValue(tenantInput && tenantInput.value, '').trim()
            }
          };
          container.lastCreateHandler(payload).then(function (result) {
            if (result && result.ok) {
              if (nameInput) nameInput.value = '';
              if (providerInput) providerInput.value = 'custom';
              if (typeInput) typeInput.value = 'custom_mcp';
              if (tenantInput) tenantInput.value = '';
            }
          });
        });
      }
      var testButtons = container.querySelectorAll('[data-role="connector-test"]');
      for (var i = 0; i < testButtons.length; i++) {
        testButtons[i].addEventListener('click', function () {
          var connectorId = this.getAttribute('data-connector-id');
          container.lastTestHandler(connectorId, {});
        });
      }
      var grantButtons = container.querySelectorAll('[data-role="connector-grants"]');
      for (var j = 0; j < grantButtons.length; j++) {
        grantButtons[j].addEventListener('click', function () {
          var connectorId = this.getAttribute('data-connector-id');
          var current = findConnector(connectorId);
          var defaultValue = current && current.grants.length ? current.grants.join(', ') : '';
          var raw = typeof window.prompt === 'function'
            ? window.prompt('请输入员工 ID，使用逗号分隔', defaultValue)
            : defaultValue;
          if (raw === null) return;
          var employeeIds = raw.split(',').map(function (value) {
            return String(value || '').replace(/^\s+|\s+$/g, '');
          }).filter(function (value) { return !!value; });
          // Canonical grants payload: employee_ids array (accepted by backend rework PATCH /connectors/{id}/grants)
          container.lastGrantHandler(connectorId, { employee_ids: employeeIds });
        });
      }
    }

    function render() {
      var cards = state.items.length
        ? state.items.map(renderCard).join('')
        : '<li class="aiteam-skill-card"><div class="aiteam-skill-card__meta">当前企业暂无已配置连接器</div></li>';
      container.innerHTML =
        '<div class="aiteam-shell__panel">' +
        '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
        '<h2 class="aiteam-shell__panel-title">连接器中心</h2>' +
        '<p class="aiteam-shell__panel-body">B05 页面通过 `/api/team/connectors` 渲染后端持久化的连接器状态、授权员工、配置摘要与最近检测时间；`POST /api/team/connectors/{id}/test` 与 `PATCH /api/team/connectors/{id}/grants` 成功后会重新拉取列表，避免前端展示刷新后无法恢复的临时状态。所有 credential 字段只显示脱敏结果。</p>' +
        (state.notice ? '<div class="aiteam-state aiteam-state-empty"><p>' + esc(state.notice) + '</p></div>' : '') +
        '<form class="aiteam-shell__meta" data-role="connector-create-form">' +
        '<div class="aiteam-shell__meta-card"><label>连接器名称<br><input class="aiteam-input" type="text" data-role="connector-name" placeholder="例如：公司飞书"></label></div>' +
        '<div class="aiteam-shell__meta-card"><label>Provider<br><input class="aiteam-input" type="text" data-role="connector-provider" value="custom" placeholder="例如：feishu"></label></div>' +
        '<div class="aiteam-shell__meta-card"><label>类型<br><input class="aiteam-input" type="text" data-role="connector-type" value="custom_mcp" placeholder="preset_oauth / custom_mcp"></label></div>' +
        '<div class="aiteam-shell__meta-card"><label>Tenant Hint<br><input class="aiteam-input" type="text" data-role="connector-tenant-hint" placeholder="例如：acme"></label><br><button type="submit" class="aiteam-btn aiteam-btn--sm">新建连接器</button></div>' +
        '</form>' +
        '<div class="aiteam-shell__meta">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">安全策略</span><span class="aiteam-shell__meta-value">credential_ref 仅以引用形式脱敏展示，不回显明文</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">列表真相</span><span class="aiteam-shell__meta-value">配置 / grants / 最近检测时间均以 `/api/team/connectors` 返回为准</span></div>' +
        '</div>' +
        '<ul class="aiteam-skills-list">' + cards + '</ul>' +
        '</div>';
      bindEvents();
    }

    function refreshList(options) {
      var config = options || {};
      return ns.api.getConnectors().then(function (result) {
        if (!result.ok) {
          if (config.errorNotice) setNotice(config.errorNotice + apiErrorMessage(result));
          render();
          return result;
        }
        state.items = normalizeItems(result.data).map(normalizeConnector);
        state.loadState = 'ready';
        if (config.notice !== undefined) setNotice(config.notice);
        render();
        return result;
      });
    }

    function upsertConnector(patch) {
      var connector = normalizeConnector(patch);
      var nextItems = [];
      var found = false;
      for (var i = 0; i < state.items.length; i++) {
        if (state.items[i].connector_id === connector.connector_id) {
          nextItems.push(normalizeConnector(Object.assign({}, state.items[i], connector)));
          found = true;
        } else {
          nextItems.push(state.items[i]);
        }
      }
      if (!found) nextItems.unshift(connector);
      state.items = nextItems;
    }

    function findConnector(connectorId) {
      for (var i = 0; i < state.items.length; i++) {
        if (state.items[i].connector_id === connectorId) return state.items[i];
      }
      return null;
    }

    container.lastCreateHandler = function (payload) {
      if (!ns.api || !ns.api.createConnector) {
        setNotice('当前 API client 未接入 createConnector');
        render();
        return Promise.resolve({ ok: false, status: 0, error: 'missing_createConnector' });
      }
      state.pendingAction = 'create';
      setNotice('');
      return ns.api.createConnector(payload).then(function (result) {
        state.pendingAction = '';
        if (result && result.ok) {
          return refreshList({
            notice: '企业连接器已创建',
            errorNotice: '企业连接器创建成功，但列表刷新失败：',
          }).then(function () {
            return result;
          });
        }
        setNotice('企业连接器创建失败：' + esc(apiErrorMessage(result)));
        render();
        return result;
      });
    };

    container.lastTestHandler = function (connectorId, payload) {
      if (!ns.api || !ns.api.testConnector) {
        setNotice('当前 API client 未接入 testConnector');
        render();
        return Promise.resolve({ ok: false, status: 0, error: 'missing_testConnector' });
      }
      state.pendingConnectorId = connectorId;
      state.pendingAction = 'test';
      setNotice('');
      render();
      return ns.api.testConnector(connectorId, payload || {}).then(function (result) {
        state.pendingConnectorId = '';
        state.pendingAction = '';
        if (result && result.ok) {
          return refreshList({
            notice: '连接器检测完成',
            errorNotice: '连接器检测成功，但列表刷新失败：',
          }).then(function () {
            return result;
          });
        }
        setNotice('连接器检测失败：' + apiErrorMessage(result));
        render();
        return result;
      });
    };

    container.lastGrantHandler = function (connectorId, payload) {
      if (!ns.api || !ns.api.updateConnectorGrants) {
        setNotice('当前 API client 未接入 updateConnectorGrants');
        render();
        return Promise.resolve({ ok: false, status: 0, error: 'missing_updateConnectorGrants' });
      }
      state.pendingConnectorId = connectorId;
      state.pendingAction = 'grants';
      setNotice('');
      render();
      return ns.api.updateConnectorGrants(connectorId, payload || {}).then(function (result) {
        state.pendingConnectorId = '';
        state.pendingAction = '';
        if (result && result.ok) {
          return refreshList({
            notice: '连接器员工授权已更新',
            errorNotice: '连接器授权更新成功，但列表刷新失败：',
          }).then(function () {
            return result;
          });
        }
        setNotice('连接器授权更新失败：' + apiErrorMessage(result));
        render();
        return result;
      });
    };

    function load() {
      if (ns.states && ns.states.renderLoading) ns.states.renderLoading(container);
      else container.innerHTML = '<div class="aiteam-state aiteam-state-loading"><p>加载连接器数据...</p></div>';
      refreshList().then(function (result) {
        if (!result.ok) {
          state.loadState = 'error';
          renderNotReady(result);
        }
      });
    }

    return { load: load };
  }

  ns.pages.adminConnectors = {
    init: function (container) {
      if (!container) return;
      var role = ns.role ? ns.role.getActiveRole() : '';
      if (role === 'finance_admin' || role === 'member') {
        renderPermissionDenied(container);
        return;
      }
      if (!ns.api || !ns.api.getConnectors) {
        container.innerHTML = '<div class="aiteam-state aiteam-state-error"><p>连接器 API client 未加载</p></div>';
        return;
      }
      createController(container).load();
    },
  };
}(window.aiteam));