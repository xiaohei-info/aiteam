window.aiteam = window.aiteam || {};

(function registerAdminConnectorsPage(ns) {
  ns.pages = ns.pages || {};

  var ACCESS_MODE_LABELS = {
    invoke: '仅调用',
    invoke_and_writeback: '调用并回写',
  };

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

  function normalizeDefinitions(payload) {
    if (!payload) return [];
    if (Array.isArray(payload.definitions)) return payload.definitions.slice();
    return [];
  }

  function normalizeEmployees(payload) {
    if (!payload) return [];
    if (Array.isArray(payload.available_employees)) return payload.available_employees.slice();
    if (Array.isArray(payload.employees)) return payload.employees.slice();
    if (Array.isArray(payload.items)) return payload.items.slice();
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

  function normalizeGrant(item) {
    if (!item || typeof item !== 'object') return null;
    var enabled = item.enabled !== false;
    return {
      binding_id: stringValue(item.binding_id, ''),
      employee_id: stringValue(item.employee_id, ''),
      employee_display_name: stringValue(item.employee_display_name || item.display_name, ''),
      enabled: enabled,
      access_mode: stringValue(item.access_mode, 'invoke'),
      status: stringValue(item.status, ''),
    };
  }

  function normalizeTestResult(result, fallbackStatus, fallbackCheckedAt, fallbackMessage) {
    var source = result && typeof result === 'object' ? result : {};
    return {
      result: stringValue(source.result, fallbackCheckedAt ? 'passed' : 'never_tested'),
      checked_at: stringValue(source.checked_at, fallbackCheckedAt || ''),
      checked_by: stringValue(source.checked_by, ''),
      error_code: stringValue(source.error_code, ''),
      message: stringValue(source.message, fallbackMessage || ''),
      log_ref: stringValue(source.log_ref, ''),
      status: stringValue(source.status, fallbackStatus || ''),
    };
  }

  function normalizeConnector(item) {
    var grants = item && (item.employee_grants || item.grants || []) || [];
    var status = stringValue(item && (item.status || item.health_status), 'draft');
    var config = item && (item.config || item.config_json || item.connection_config) || {};
    var credentialState = stringValue(item && item.credential_state, '');
    var credentialMask = stringValue(
      item && item.credential_mask,
      credentialState ? '已配置' : '未配置'
    );
    var lastTestResult = normalizeTestResult(
      item && item.last_test_result,
      status,
      stringValue(item && (item.last_test_at || item.last_validated_at), ''),
      stringValue(item && (item.test_log || item.last_test_log), '')
    );
    return {
      connector_id: stringValue(item && (item.connector_id || item.id), ''),
      definition_id: stringValue(item && item.definition_id, ''),
      name: stringValue(item && item.name, '未命名连接器'),
      provider: stringValue(item && (item.provider || item.provider_code), 'custom'),
      type: stringValue(item && (item.type || item.connector_type || item.auth_type), 'custom_mcp'),
      status: status,
      health_status: stringValue(item && item.health_status, status),
      scopes: Array.isArray(item && item.scopes) ? item.scopes.slice() : [],
      credential_ref: stringValue(item && item.credential_ref, ''),
      credential_mask: credentialMask,
      credential_state: credentialState || (credentialMask === '未配置' ? 'missing' : 'configured'),
      rotation_version: item && item.rotation_version != null ? String(item.rotation_version) : '—',
      config_summary: maskConfig(config),
      raw_config: maskNested(config),
      employee_grants: grants.map(normalizeGrant).filter(Boolean),
      granted_employee_ids: Array.isArray(item && item.granted_employee_ids) ? item.granted_employee_ids.slice() : [],
      last_test_result: lastTestResult,
      updated_at: stringValue(item && item.updated_at, ''),
      updated_by: stringValue(item && item.updated_by, ''),
      created_at: stringValue(item && item.created_at, ''),
    };
  }

  function normalizeDefinition(item) {
    if (!item || typeof item !== 'object') return null;
    return {
      definition_id: stringValue(item.definition_id, ''),
      provider_code: stringValue(item.provider_code, 'custom'),
      connector_type: stringValue(item.connector_type, 'custom_mcp'),
      display_name: stringValue(item.display_name, '未命名定义'),
      auth_scheme: stringValue(item.auth_scheme, 'opaque_ref'),
      status: stringValue(item.status, 'active'),
    };
  }

  function normalizeEmployee(item) {
    if (!item || typeof item !== 'object') return null;
    return {
      employee_id: stringValue(item.employee_id || item.id, ''),
      display_name: stringValue(item.display_name || item.name, '未命名员工'),
      status: stringValue(item.status, 'unknown'),
    };
  }

  function statusLabel(status) {
    var labels = {
      draft: '草稿',
      online: '在线',
      offline: '离线',
      auth_failed: '认证失败',
      archived: '已归档',
    };
    return labels[status] || stringValue(status, '未知');
  }

  function credentialStateLabel(state) {
    var labels = {
      missing: '未配置',
      configured: '已配置',
      rotated: '已轮换待复测',
      invalid: '无效',
      revoked: '已撤销',
    };
    return labels[state] || stringValue(state, '未知');
  }

  function testResultLabel(result) {
    var labels = {
      passed: '通过',
      failed: '失败',
      skipped: '已跳过',
      never_tested: '未测试',
      running: '检测中',
    };
    return labels[result] || stringValue(result, '未知');
  }

  function apiErrorMessage(result) {
    if (result && result.status === 403) return '您没有权限访问连接器配置';
    if (result && result.status === 404) return '连接器接口尚未开放';
    if (result && result.status === 409) return '当前连接器状态不允许执行此操作';
    if (result && result.status === 422) return '请求参数不符合连接器契约';
    if (result && result.status === 501) return '连接器接口尚未实现';
    if (result && result.error) return result.error;
    if (result && result.data && result.data.message) return result.data.message;
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
      definitions: [],
      availableEmployees: [],
      notice: '',
      loadState: 'loading',
      pendingConnectorId: '',
      pendingAction: '',
      selectedConnectorId: '',
      detailState: 'idle',
      detailNotice: '',
      detailDraft: {
        name: '',
        config_tenant_hint: '',
        config_channel: '',
        credential_ref: '',
      },
      grantDraft: {},
      createDraft: {
        definition_id: '',
        provider_code: 'custom',
        connector_type: 'custom_mcp',
        name: '',
        config_channel: '',
        config_tenant_hint: '',
        credential_ref: '',
      },
    };

    function setNotice(message) {
      state.notice = message || '';
    }

    function setDetailNotice(message) {
      state.detailNotice = message || '';
    }

    function getSelectedConnector() {
      return findConnector(state.selectedConnectorId) || state.items[0] || null;
    }

    function syncDetailDraft(item) {
      var config = item && item.raw_config && typeof item.raw_config === 'object' ? item.raw_config : {};
      state.detailDraft = {
        name: stringValue(item && item.name, ''),
        config_tenant_hint: stringValue(config.tenant_hint, ''),
        config_channel: stringValue(config.channel, ''),
        credential_ref: '',
      };
    }

    function readCreateDraftFromDom() {
      if (!container || !container.querySelector) return;
      var definitionInput = container.querySelector('[data-role="connector-definition"]');
      var providerInput = container.querySelector('[data-role="connector-provider"]');
      var typeInput = container.querySelector('[data-role="connector-type"]');
      var nameInput = container.querySelector('[data-role="connector-name"]');
      var tenantInput = container.querySelector('[data-role="connector-tenant-hint"]');
      var channelInput = container.querySelector('[data-role="connector-channel"]');
      var credentialInput = container.querySelector('[data-role="connector-credential-ref"]');
      state.createDraft.definition_id = stringValue(definitionInput && definitionInput.value, '').trim();
      state.createDraft.provider_code = stringValue(providerInput && providerInput.value, 'custom').trim();
      state.createDraft.connector_type = stringValue(typeInput && typeInput.value, 'custom_mcp').trim();
      state.createDraft.name = stringValue(nameInput && nameInput.value, '').trim();
      state.createDraft.config_tenant_hint = stringValue(tenantInput && tenantInput.value, '').trim();
      state.createDraft.config_channel = stringValue(channelInput && channelInput.value, '').trim();
      state.createDraft.credential_ref = stringValue(credentialInput && credentialInput.value, '').trim();
    }

    function resetCreateDraft() {
      state.createDraft = {
        definition_id: '',
        provider_code: 'custom',
        connector_type: 'custom_mcp',
        name: '',
        config_channel: '',
        config_tenant_hint: '',
        credential_ref: '',
      };
    }

    function readDetailDraftFromDom(connectorId) {
      if (!container || !container.querySelector) return;
      state.detailDraft.name = stringValue((container.querySelector('[data-role="detail-name-' + connectorId + '"]') || {}).value, '').trim();
      state.detailDraft.config_tenant_hint = stringValue((container.querySelector('[data-role="detail-tenant-hint-' + connectorId + '"]') || {}).value, '').trim();
      state.detailDraft.config_channel = stringValue((container.querySelector('[data-role="detail-channel-' + connectorId + '"]') || {}).value, '').trim();
      state.detailDraft.credential_ref = stringValue((container.querySelector('[data-role="credential-input-' + connectorId + '"]') || {}).value, '').trim();
    }

    function ensureSelectedConnector() {
      if (!state.selectedConnectorId && state.items.length) {
        state.selectedConnectorId = state.items[0].connector_id;
      }
      if (state.selectedConnectorId && !findConnector(state.selectedConnectorId) && state.items.length) {
        state.selectedConnectorId = state.items[0].connector_id;
      }
      var selected = getSelectedConnector();
      if (selected) syncDetailDraft(selected);
    }

    function emptyDefinitionsMarkup() {
      return '<option value="">自定义连接器（无预设定义）</option>';
    }

    function definitionsMarkup() {
      if (!state.definitions.length) return emptyDefinitionsMarkup();
      return emptyDefinitionsMarkup() + state.definitions.map(function (item) {
        var selected = state.createDraft.definition_id === item.definition_id ? ' selected' : '';
        return '<option value="' + esc(item.definition_id) + '" data-provider="' + esc(item.provider_code) + '" data-type="' + esc(item.connector_type) + '"' + selected + '>' + esc(item.display_name) + ' · ' + esc(item.auth_scheme) + '</option>';
      }).join('');
    }

    function employeeOptionsMarkup(selectedGrantIds) {
      var selected = selectedGrantIds || [];
      if (!state.availableEmployees.length) {
        return '<div class="aiteam-state aiteam-state-empty"><p>暂无可授权员工</p></div>';
      }
      return state.availableEmployees.map(function (employee) {
        var checked = selected.indexOf(employee.employee_id) !== -1 ? ' checked' : '';
        return '<label class="aiteam-shell__meta-card">' +
          '<input type="checkbox" data-role="grant-checkbox" value="' + esc(employee.employee_id) + '"' + checked + '>' +
          '<span class="aiteam-shell__meta-label">' + esc(employee.display_name) + '</span>' +
          '<span class="aiteam-shell__meta-value">' + esc(employee.employee_id) + ' · ' + esc(employee.status) + '</span>' +
          '</label>';
      }).join('');
    }

    function renderNotReady(result) {
      container.innerHTML =
        '<div class="aiteam-shell__panel">' +
        '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
        '<h2 class="aiteam-shell__panel-title">连接器中心</h2>' +
        '<p class="aiteam-shell__panel-body">B05 连接器管理页按冻结契约消费 `/api/team/connectors`、`/api/team/connectors/{id}`、`PATCH /api/team/connectors/{id}`、`/api/team/connectors/{id}/test`、`/api/team/connectors/{id}/grants`。若后端不可用，页面仅展示真实失败态，不伪造 detail/update 成功结果或 raw secret。</p>' +
        '<div class="aiteam-shell__meta">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">安全约束</span><span class="aiteam-shell__meta-value">凭据输入只接受 opaque ref，页面不展示 raw secret</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">当前状态</span><span class="aiteam-shell__meta-value">' + esc(apiErrorMessage(result)) + '</span></div>' +
        '</div>' +
        '</div>';
    }

    function renderConnectorListItem(item) {
      var active = state.selectedConnectorId === item.connector_id ? ' is-active' : '';
      var grantedCount = item.employee_grants.filter(function (grant) { return grant.enabled; }).length;
      return '<button type="button" class="aiteam-skill-card aiteam-skill-card--button' + active + '" data-role="connector-select" data-connector-id="' + esc(item.connector_id) + '">' +
        '<span class="aiteam-skill-card__title">' + esc(item.name) + '</span>' +
        '<span class="aiteam-skill-card__meta">' + esc(item.provider) + ' · ' + esc(item.type) + '</span>' +
        '<span class="aiteam-skill-card__meta">状态：' + esc(statusLabel(item.status)) + ' · 凭据：' + esc(credentialStateLabel(item.credential_state)) + '</span>' +
        '<span class="aiteam-skill-card__meta">授权员工：' + esc(String(grantedCount)) + ' 人</span>' +
        '</button>';
    }

    function renderGrantSummary(item) {
      var enabledGrants = item.employee_grants.filter(function (grant) { return grant.enabled; });
      if (!enabledGrants.length) {
        return '<div class="aiteam-state aiteam-state-empty"><p>当前尚未授权员工</p></div>';
      }
      return enabledGrants.map(function (grant) {
        var displayName = grant.employee_display_name || grant.employee_id;
        return '<div class="aiteam-shell__meta-card">' +
          '<span class="aiteam-shell__meta-label">' + esc(displayName) + '</span>' +
          '<span class="aiteam-shell__meta-value">' + esc(grant.employee_id) + ' · ' + esc(ACCESS_MODE_LABELS[grant.access_mode] || grant.access_mode) + '</span>' +
          '</div>';
      }).join('');
    }

    function renderLastTest(item) {
      var result = item.last_test_result;
      var message = result.message || (result.result === 'never_tested' ? '尚未执行连接测试' : '已获取最近一次测试结果');
      return '<div class="aiteam-shell__meta">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">测试结果</span><span class="aiteam-shell__meta-value">' + esc(testResultLabel(result.result)) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">检查时间</span><span class="aiteam-shell__meta-value">' + esc(stringValue(result.checked_at, '暂无记录')) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">状态刷新</span><span class="aiteam-shell__meta-value">' + esc(statusLabel(item.status)) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">摘要</span><span class="aiteam-shell__meta-value">' + esc(message) + '</span></div>' +
        (result.error_code ? '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">错误码</span><span class="aiteam-shell__meta-value">' + esc(result.error_code) + '</span></div>' : '') +
        (result.log_ref ? '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">日志引用</span><span class="aiteam-shell__meta-value">' + esc(result.log_ref) + '</span></div>' : '') +
        '</div>';
    }

    function renderDetail(item) {
      if (!item) {
        return '<div class="aiteam-state aiteam-state-empty"><p>当前企业暂无已配置连接器</p></div>';
      }
      var actionDisabled = state.pendingConnectorId === item.connector_id ? ' disabled' : '';
      var grantSelectedIds = state.grantDraft[item.connector_id] || item.employee_grants.filter(function (grant) {
        return grant.enabled;
      }).map(function (grant) {
        return grant.employee_id;
      });
      return '<div class="aiteam-shell__panel">' +
        '<p class="aiteam-shell__panel-kicker">连接器详情</p>' +
        '<h3 class="aiteam-shell__panel-title">' + esc(item.name) + '</h3>' +
        '<p class="aiteam-shell__panel-body">按冻结契约显示 provider、类型、状态、作用域、配置摘要、opaque credential ref 与凭据脱敏状态；详情编辑只提交 name/config/credential_input 等允许字段，浏览器不展示 raw secret，只消费 Team Panel 返回的安全字段。</p>' +
        (state.detailNotice ? '<div class="aiteam-state aiteam-state-info"><p>' + esc(state.detailNotice) + '</p></div>' : '') +
        '<div class="aiteam-shell__meta">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">Provider</span><span class="aiteam-shell__meta-value">' + esc(item.provider) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">类型</span><span class="aiteam-shell__meta-value">' + esc(item.type) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">连接状态</span><span class="aiteam-shell__meta-value">' + esc(statusLabel(item.status)) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">作用域</span><span class="aiteam-shell__meta-value">' + esc(item.scopes.length ? item.scopes.join(', ') : '未声明') + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">凭据显示</span><span class="aiteam-shell__meta-value">' + esc(item.credential_mask) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">凭据标识</span><span class="aiteam-shell__meta-value">' + esc(item.credential_ref || '未配置') + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">凭据状态</span><span class="aiteam-shell__meta-value">' + esc(credentialStateLabel(item.credential_state)) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">轮换版本</span><span class="aiteam-shell__meta-value">' + esc(item.rotation_version) + '</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">配置摘要</span><span class="aiteam-shell__meta-value">' + esc(item.config_summary || '暂无自定义配置') + '</span></div>' +
        '</div>' +
        '<div class="aiteam-shell__meta">' +
        '<div class="aiteam-shell__meta-card"><label>连接器名称<br><input class="aiteam-input" type="text" data-role="detail-name-' + esc(item.connector_id) + '" placeholder="例如：公司 Slack" value="' + esc(state.detailDraft.name) + '"></label></div>' +
        '<div class="aiteam-shell__meta-card"><label>Tenant Hint<br><input class="aiteam-input" type="text" data-role="detail-tenant-hint-' + esc(item.connector_id) + '" placeholder="例如：acme" value="' + esc(state.detailDraft.config_tenant_hint) + '"></label></div>' +
        '<div class="aiteam-shell__meta-card"><label>Channel<br><input class="aiteam-input" type="text" data-role="detail-channel-' + esc(item.connector_id) + '" placeholder="例如：#sales" value="' + esc(state.detailDraft.config_channel) + '"></label></div>' +
        '<div class="aiteam-shell__meta-card"><label>更新凭据标识（受控输入）<br><input class="aiteam-input" type="text" data-role="credential-input-' + esc(item.connector_id) + '" placeholder="cred://enterprise/..." value="' + esc(state.detailDraft.credential_ref) + '"></label></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">保存后展示</span><span class="aiteam-shell__meta-value">显示 opaque credential ref、脱敏状态、更新时间等安全字段；不展示 raw secret</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">更新口径</span><span class="aiteam-shell__meta-value">提交 PATCH /connectors/{id} 后重新拉取 detail 与列表，避免本地伪造更新结果</span></div>' +
        '</div>' +
        '<div class="aiteam-skill-card__actions">' +
        '<button type="button" class="aiteam-btn" data-role="connector-save" data-connector-id="' + esc(item.connector_id) + '"' + actionDisabled + '>保存详情</button>' +
        '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="connector-test" data-connector-id="' + esc(item.connector_id) + '"' + actionDisabled + '>测试连接</button>' +
        '<button type="button" class="aiteam-btn aiteam-btn--secondary" data-role="connector-refresh" data-connector-id="' + esc(item.connector_id) + '"' + actionDisabled + '>刷新状态</button>' +
        '<button type="button" class="aiteam-btn" data-role="connector-grants" data-connector-id="' + esc(item.connector_id) + '"' + actionDisabled + '>保存员工授权</button>' +
        '</div>' +
        '<h4 class="aiteam-shell__panel-kicker">最近测试</h4>' +
        renderLastTest(item) +
        '<h4 class="aiteam-shell__panel-kicker">已授权员工</h4>' +
        renderGrantSummary(item) +
        '<h4 class="aiteam-shell__panel-kicker">授权编辑</h4>' +
        '<div class="aiteam-shell__meta">' + employeeOptionsMarkup(grantSelectedIds) + '</div>' +
        '</div>';
    }

    function render() {
      ensureSelectedConnector();
      var selected = getSelectedConnector();
      var listMarkup = state.items.length
        ? state.items.map(renderConnectorListItem).join('')
        : '<div class="aiteam-state aiteam-state-empty"><p>当前企业暂无已配置连接器</p></div>';
      container.innerHTML =
        '<div class="aiteam-shell__panel">' +
        '<p class="aiteam-shell__panel-kicker">企业后台</p>' +
        '<h2 class="aiteam-shell__panel-title">连接器中心</h2>' +
        '<p class="aiteam-shell__panel-body">B05 页面按冻结契约展示凭据脱敏、详情编辑、最近测试、状态刷新与员工授权；列表真相以 `/api/team/connectors` 为准，detail/update/test/grants 成功后重新拉取，避免前端残留临时状态。</p>' +
        (state.notice ? '<div class="aiteam-state aiteam-state-info"><p>' + esc(state.notice) + '</p></div>' : '') +
        '<form class="aiteam-shell__meta" data-role="connector-create-form">' +
        '<div class="aiteam-shell__meta-card"><label>预设定义<br><select class="aiteam-input" data-role="connector-definition">' + definitionsMarkup() + '</select></label></div>' +
        '<div class="aiteam-shell__meta-card"><label>连接器名称<br><input class="aiteam-input" type="text" data-role="connector-name" placeholder="例如：公司飞书" value="' + esc(state.createDraft.name) + '"></label></div>' +
        '<div class="aiteam-shell__meta-card"><label>Provider<br><input class="aiteam-input" type="text" data-role="connector-provider" value="' + esc(state.createDraft.provider_code) + '" placeholder="例如：feishu"></label></div>' +
        '<div class="aiteam-shell__meta-card"><label>类型<br><input class="aiteam-input" type="text" data-role="connector-type" value="' + esc(state.createDraft.connector_type) + '" placeholder="例如：webhook_target"></label></div>' +
        '<div class="aiteam-shell__meta-card"><label>Tenant Hint<br><input class="aiteam-input" type="text" data-role="connector-tenant-hint" placeholder="例如：acme" value="' + esc(state.createDraft.config_tenant_hint) + '"></label></div>' +
        '<div class="aiteam-shell__meta-card"><label>Channel<br><input class="aiteam-input" type="text" data-role="connector-channel" placeholder="例如：#sales" value="' + esc(state.createDraft.config_channel) + '"></label></div>' +
        '<div class="aiteam-shell__meta-card"><label>Credential Ref（受控输入）<br><input class="aiteam-input" type="text" data-role="connector-credential-ref" placeholder="cred://enterprise/opaque-id" value="' + esc(state.createDraft.credential_ref) + '"></label><br><button type="submit" class="aiteam-btn aiteam-btn--sm">新建连接器</button></div>' +
        '</form>' +
        '<div class="aiteam-shell__meta">' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">安全策略</span><span class="aiteam-shell__meta-value">raw secret 不进入页面；只显示 opaque credential ref 与脱敏状态</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">测试口径</span><span class="aiteam-shell__meta-value">running / success / failure 与 last_test_result 以后端返回为准</span></div>' +
        '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">授权口径</span><span class="aiteam-shell__meta-value">已授权员工 / 未授权空态 / 错误态均不绕过后端语义</span></div>' +
        '</div>' +
        '<div class="aiteam-shell__two-column">' +
        '<div class="aiteam-shell__panel"><h3 class="aiteam-shell__panel-title">连接器列表</h3>' + listMarkup + '</div>' +
        renderDetail(selected) +
        '</div>' +
        '</div>';
      bindEvents();
    }

    function findConnector(connectorId) {
      for (var i = 0; i < state.items.length; i++) {
        if (state.items[i].connector_id === connectorId) return state.items[i];
      }
      return null;
    }

    function selectedGrantIds(connectorId) {
      if (state.grantDraft[connectorId]) return state.grantDraft[connectorId].slice();
      var connector = findConnector(connectorId);
      if (!connector) return [];
      return connector.employee_grants.filter(function (grant) {
        return grant.enabled;
      }).map(function (grant) {
        return grant.employee_id;
      });
    }

    function bindEvents() {
      if (!container || !container.querySelectorAll) return;
      var createForm = container.querySelector('[data-role="connector-create-form"]');
      if (createForm && createForm.addEventListener) {
        createForm.addEventListener('submit', function (event) {
          if (event && event.preventDefault) event.preventDefault();
          readCreateDraftFromDom();
          var payload = {
            definition_id: state.createDraft.definition_id || undefined,
            name: state.createDraft.name,
            provider_code: state.createDraft.provider_code || 'custom',
            connector_type: state.createDraft.connector_type || 'custom_mcp',
            config: {
              tenant_hint: state.createDraft.config_tenant_hint,
              channel: state.createDraft.config_channel,
            },
          };
          if (state.createDraft.credential_ref) {
            payload.credential_input = {
              mode: 'opaque_ref',
              credential_ref: state.createDraft.credential_ref,
            };
          }
          container.lastCreateHandler(payload).then(function (result) {
            if (result && result.ok) {
              resetCreateDraft();
            }
          });
        });
      }

      var definitionInput = container.querySelector('[data-role="connector-definition"]');
      if (definitionInput && definitionInput.addEventListener) {
        definitionInput.addEventListener('change', function () {
          state.createDraft.definition_id = stringValue(this.value, '');
          var definition = null;
          for (var i = 0; i < state.definitions.length; i++) {
            if (state.definitions[i].definition_id === state.createDraft.definition_id) {
              definition = state.definitions[i];
              break;
            }
          }
          if (definition) {
            state.createDraft.provider_code = definition.provider_code;
            state.createDraft.connector_type = definition.connector_type;
            render();
          }
        });
      }

      var selectButtons = container.querySelectorAll('[data-role="connector-select"]');
      for (var i = 0; i < selectButtons.length; i++) {
        selectButtons[i].addEventListener('click', function () {
          state.selectedConnectorId = this.getAttribute('data-connector-id');
          setDetailNotice('正在拉取连接器详情...');
          render();
          refreshDetail(state.selectedConnectorId, {
            notice: '详情已按 detail 接口刷新。',
            errorNotice: '详情刷新失败：',
          });
        });
      }

      var saveButtons = container.querySelectorAll('[data-role="connector-save"]');
      for (var saveIndex = 0; saveIndex < saveButtons.length; saveIndex++) {
        saveButtons[saveIndex].addEventListener('click', function () {
          var connectorId = this.getAttribute('data-connector-id');
          readDetailDraftFromDom(connectorId);
          var payload = {
            name: state.detailDraft.name,
            config: {
              tenant_hint: state.detailDraft.config_tenant_hint,
              channel: state.detailDraft.config_channel,
            },
          };
          if (state.detailDraft.credential_ref) {
            payload.credential_input = {
              mode: 'opaque_ref',
              credential_ref: state.detailDraft.credential_ref,
            };
          }
          container.lastUpdateHandler(connectorId, payload);
        });
      }

      var testButtons = container.querySelectorAll('[data-role="connector-test"]');
      for (var j = 0; j < testButtons.length; j++) {
        testButtons[j].addEventListener('click', function () {
          var connectorId = this.getAttribute('data-connector-id');
          container.lastTestHandler(connectorId, { mode: 'manual', dry_run: false });
        });
      }

      var refreshButtons = container.querySelectorAll('[data-role="connector-refresh"]');
      for (var k = 0; k < refreshButtons.length; k++) {
        refreshButtons[k].addEventListener('click', function () {
          var connectorId = this.getAttribute('data-connector-id');
          container.lastStatusHandler(connectorId);
        });
      }

      var checkboxes = container.querySelectorAll('[data-role="grant-checkbox"]');
      for (var n = 0; n < checkboxes.length; n++) {
        checkboxes[n].addEventListener('change', function () {
          var current = getSelectedConnector();
          if (!current) return;
          var ids = [];
          var nodes = container.querySelectorAll('[data-role="grant-checkbox"]');
          for (var idx = 0; idx < nodes.length; idx++) {
            if (nodes[idx].checked) ids.push(nodes[idx].value);
          }
          state.grantDraft[current.connector_id] = ids;
        });
      }

      var grantButtons = container.querySelectorAll('[data-role="connector-grants"]');
      for (var m = 0; m < grantButtons.length; m++) {
        grantButtons[m].addEventListener('click', function () {
          var connectorId = this.getAttribute('data-connector-id');
          var current = findConnector(connectorId);
          var selectedIds = selectedGrantIds(connectorId);
          var revoke = [];
          if (current) {
            current.employee_grants.forEach(function (grant) {
              if (grant.enabled && selectedIds.indexOf(grant.employee_id) === -1 && grant.binding_id) {
                revoke.push({ binding_id: grant.binding_id });
              }
            });
          }
          var grantPayload = selectedIds.length ? [{ employee_ids: selectedIds, access_mode: 'invoke' }] : [];
          container.lastGrantHandler(connectorId, { grant: grantPayload, revoke: revoke });
        });
      }
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
        state.definitions = normalizeDefinitions(result.data).map(normalizeDefinition).filter(Boolean);
        state.loadState = 'ready';
        if (config.notice !== undefined) setNotice(config.notice);
        ensureSelectedConnector();
        render();
        return result;
      });
    }

    function refreshDetail(connectorId, options) {
      var config = options || {};
      if (!ns.api || !ns.api.getConnector) {
        if (config.errorNotice) setDetailNotice(config.errorNotice + '当前 API client 未接入 getConnector');
        render();
        return Promise.resolve({ ok: false, status: 0, error: 'missing_getConnector' });
      }
      state.detailState = 'loading';
      return ns.api.getConnector(connectorId).then(function (result) {
        state.detailState = 'idle';
        if (!result.ok) {
          if (config.errorNotice) setDetailNotice(config.errorNotice + apiErrorMessage(result));
          render();
          return result;
        }
        var detail = normalizeConnector(result.data);
        var replaced = false;
        for (var i = 0; i < state.items.length; i++) {
          if (state.items[i].connector_id === connectorId) {
            state.items[i] = detail;
            replaced = true;
            break;
          }
        }
        if (!replaced) state.items.unshift(detail);
        syncDetailDraft(detail);
        if (config.notice !== undefined) setDetailNotice(config.notice);
        render();
        return result;
      });
    }

    function refreshEmployees() {
      if (!ns.api || !ns.api.getEmployees) {
        state.availableEmployees = [];
        return Promise.resolve({ ok: false, status: 0, error: 'missing_getEmployees' });
      }
      return ns.api.getEmployees().then(function (result) {
        if (result && result.ok) {
          state.availableEmployees = normalizeEmployees(result.data).map(normalizeEmployee).filter(Boolean);
          return result;
        }
        state.availableEmployees = [];
        return result;
      });
    }

    container.lastCreateHandler = function (payload) {
      if (!ns.api || !ns.api.createConnector) {
        setNotice('当前 API client 未接入 createConnector');
        render();
        return Promise.resolve({ ok: false, status: 0, error: 'missing_createConnector' });
      }
      state.pendingAction = 'create';
      setNotice('');
      render();
      return ns.api.createConnector(payload).then(function (result) {
        state.pendingAction = '';
        if (result && result.ok) {
          return refreshList({
            notice: '企业连接器已创建，页面仅展示脱敏凭据结果',
            errorNotice: '企业连接器创建成功，但列表刷新失败：',
          }).then(function () {
            return result;
          });
        }
        setNotice('企业连接器创建失败：' + apiErrorMessage(result));
        render();
        return result;
      });
    };

    container.lastUpdateHandler = function (connectorId, payload) {
      if (!ns.api || !ns.api.updateConnector) {
        setDetailNotice('当前 API client 未接入 updateConnector');
        render();
        return Promise.resolve({ ok: false, status: 0, error: 'missing_updateConnector' });
      }
      state.pendingConnectorId = connectorId;
      state.pendingAction = 'update';
      setNotice('');
      setDetailNotice('正在保存连接器详情...');
      render();
      return ns.api.updateConnector(connectorId, payload || {}).then(function (result) {
        state.pendingConnectorId = '';
        state.pendingAction = '';
        if (result && result.ok) {
          return refreshDetail(connectorId, {
            notice: '详情已按 detail 接口刷新。',
            errorNotice: '详情保存成功，但 detail 刷新失败：',
          }).then(function () {
            return refreshList({
              notice: '连接器详情已更新，列表已按后端结果刷新',
              errorNotice: '连接器详情已更新，但列表刷新失败：',
            });
          }).then(function () {
            return result;
          });
        }
        setDetailNotice('');
        setNotice('连接器详情更新失败：' + apiErrorMessage(result));
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
      setDetailNotice('检测已触发，等待后端刷新 last_test_result 与状态。');
      setNotice('');
      var current = findConnector(connectorId);
      if (current) {
        current.last_test_result.result = 'running';
        current.last_test_result.message = '连接测试进行中';
      }
      render();
      return ns.api.testConnector(connectorId, payload || {}).then(function (result) {
        state.pendingConnectorId = '';
        state.pendingAction = '';
        if (result && result.ok) {
          return refreshList({
            notice: '连接器检测完成，已按后端返回刷新状态',
            errorNotice: '连接器检测成功，但列表刷新失败：',
          }).then(function () {
            return result;
          });
        }
        setDetailNotice('');
        setNotice('连接器检测失败：' + apiErrorMessage(result));
        render();
        return result;
      });
    };

    container.lastStatusHandler = function (connectorId) {
      state.pendingConnectorId = connectorId;
      state.pendingAction = 'status';
      setDetailNotice('正在刷新连接器状态...');
      render();
      var runner = (!ns.api || !ns.api.getConnectorStatus)
        ? Promise.resolve({ ok: false, status: 0, error: 'missing_getConnectorStatus' })
        : ns.api.getConnectorStatus(connectorId);
      return runner.then(function (result) {
        state.pendingConnectorId = '';
        state.pendingAction = '';
        if (result && result.ok) {
          var current = findConnector(connectorId);
          if (current) {
            current.status = stringValue(result.data && result.data.status, current.status);
            current.credential_state = stringValue(result.data && result.data.credential_state, current.credential_state);
            current.updated_at = stringValue(result.data && result.data.updated_at, current.updated_at);
            current.last_test_result = normalizeTestResult(result.data && result.data.last_test_result, current.status, current.last_test_result.checked_at, current.last_test_result.message);
          }
          setDetailNotice('状态已按 status 接口刷新。');
          render();
          return result;
        }
        return refreshList({
          notice: '已回退为重新拉取连接器列表刷新状态',
          errorNotice: '状态刷新失败：',
        }).then(function () {
          setDetailNotice('当前后端未开放 status 接口，已回退为重新拉取列表。');
          return result;
        });
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
      setDetailNotice('');
      render();
      return ns.api.updateConnectorGrants(connectorId, payload || {}).then(function (result) {
        state.pendingConnectorId = '';
        state.pendingAction = '';
        if (result && result.ok) {
          return refreshList({
            notice: '连接器员工授权已更新',
            errorNotice: '连接器授权更新成功，但列表刷新失败：',
          }).then(function () {
            state.grantDraft[connectorId] = null;
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
      Promise.all([refreshEmployees(), refreshList()]).then(function (results) {
        var listResult = results[1];
        if (!listResult.ok) {
          state.loadState = 'error';
          renderNotReady(listResult);
          return;
        }
        var selected = getSelectedConnector();
        if (selected) {
          refreshDetail(selected.connector_id, {
            notice: '详情已按 detail 接口刷新。',
            errorNotice: '详情刷新失败：',
          });
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
