// admin-employee-drawer.js — employee configuration drawer aligned to /api/team/employees/{id}
window.aiteam = window.aiteam || {};

(function registerEmployeeDrawerModule(ns) {
  ns.pages = ns.pages || {};

  var TABS = [
    { id: 'profile', label: '基础资料' },
    { id: 'model', label: '模型' },
    { id: 'prompt', label: '提示词' },
    { id: 'skills', label: '技能' },
    { id: 'knowledge', label: '知识库' },
    { id: 'memory', label: '记忆' },
    { id: 'connectors', label: '连接器' },
    { id: 'loop', label: 'Loop' },
  ];

  var _activeTab = 'profile';
  var _employeeData = null;
  var _overlay = null;
  var _drawer = null;
  var _container = null;
  var _enterpriseSkillInstalls = [];
  var _skillInstallState = 'idle';
  var _skillNotice = '';
  var _lastEmployeeId = '';
  var _skillActionLoading = null;
  var _statusNotice = '';
  var _statusActionLoading = '';
  var _suppressHistorySync = false;
  var _configNoticeByTab = {};
  var _configLoadingByTab = {};

  function _createEl(tag, cls, attrs) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === 'text') el.textContent = attrs[key];
        else if (key === 'html') el.innerHTML = attrs[key];
        else el.setAttribute(key, attrs[key]);
      });
    }
    return el;
  }

  function _escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _stringValue(value, fallback) {
    if (value == null || value === '') return fallback || '未设置';
    return String(value);
  }

  function _listValue(list, keyOrder, emptyLabel) {
    if (!list || !list.length) return [];
    return list.map(function (item) {
      for (var i = 0; i < keyOrder.length; i++) {
        var key = keyOrder[i];
        if (item && item[key]) return item[key];
      }
      return emptyLabel;
    });
  }

  function _displayFlag(value) {
    if (value === true) return '开启';
    if (value === false) return '关闭';
    return '未设置';
  }

  function _parseBehaviorRuleLabels(value) {
    if (Array.isArray(value)) {
      return value.map(function (item) {
        return _stringValue(item, '未命名规则');
      }).filter(function (item) {
        return item !== '未命名规则';
      });
    }
    if (!value) return [];
    var parsed = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value);
      } catch (err) {
        return [_stringValue(value, '未设置')];
      }
    }
    if (Array.isArray(parsed)) {
      return parsed.map(function (item) {
        if (item && typeof item === 'object') {
          return Object.keys(item).map(function (key) {
            return key + ': ' + _stringValue(item[key], '未设置');
          }).join(' · ');
        }
        return _stringValue(item, '未命名规则');
      }).filter(Boolean);
    }
    if (parsed && typeof parsed === 'object') {
      return Object.keys(parsed).map(function (key) {
        return key + ': ' + _stringValue(parsed[key], '未设置');
      });
    }
    return [_stringValue(parsed, '未设置')];
  }

  function _findTab(tabId) {
    for (var i = 0; i < TABS.length; i++) {
      if (TABS[i].id === tabId) return TABS[i];
    }
    return null;
  }

  function _syncDrawerPath() {
    if (_suppressHistorySync || !_lastEmployeeId || typeof window === 'undefined') return;
    var nextPath = '/admin/employees/' + encodeURIComponent(_lastEmployeeId) + (_activeTab && _activeTab !== 'profile' ? '/' + encodeURIComponent(_activeTab) : '');
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, '', nextPath);
    } else if (window.location) {
      window.location.pathname = nextPath;
    }
  }

  function _removeSkillCode(skillCode) {
    if (!_employeeData || !skillCode) return;
    _employeeData.skillCodes = (_employeeData.skillCodes || []).filter(function (item) {
      return item !== skillCode;
    });
    _employeeData.skills = (_employeeData.skills || []).filter(function (item) {
      return item.name !== skillCode;
    });
  }

  function _addSkillCode(skillCode) {
    if (!_employeeData || !skillCode) return;
    if ((_employeeData.skillCodes || []).indexOf(skillCode) !== -1) return;
    _employeeData.skillCodes.push(skillCode);
    _employeeData.skills.push({
      name: skillCode,
      status: 'allow',
      meta: 'enterprise install',
    });
  }

  function normalizeEmployeePayload(payload) {
    var data = payload || {};
    var profileConfig = data.profile_config || {};
    var promptConfig = data.prompt_config || {};
    var memoryConfig = profileConfig.memory_config || null;
    var memory = profileConfig.memory || memoryConfig;
    var skills = profileConfig.skills || [];
    var connectorBindings = data.connector_bindings || [];
    var knowledgeBindings = data.knowledge_bases || [];
    var usageSummary = data.usage_summary || {};
    var maxTokens = memory && memory.max_tokens != null ? String(memory.max_tokens) : '未设置';

    // Backend GET returns top-level model_provider/model_name (Employee entity fields).
    // profile_config.model is not present in the current backend response.
    var modelProvider = data.model_provider || (profileConfig.model || {}).provider || '未设置';
    var modelName = data.model_name || (profileConfig.model || {}).name || '未设置';

    // prompt_version is a top-level Employee entity field, not inside profile_config.prompt
    var promptVersion = data.prompt_version != null ? String(data.prompt_version) : '—';

    return {
      employeeId: data.employee_id || '',
      displayName: data.display_name || '未设置',
      roleName: data.role_name || '未分配',
      status: data.status || '未知',
      presence: data.presence || 'idle',
      profileName: profileConfig.profile_name || '未配置',
      modelProvider: modelProvider,
      modelName: modelName,
      systemPrompt: _stringValue(promptConfig.system_prompt, '未设置'),
      openingMessage: _stringValue(promptConfig.opening_message, '—'),
      promptVersion: promptVersion,
      behaviorRuleLabels: _parseBehaviorRuleLabels(promptConfig.behavior_rules_json),
      skills: skills.map(function (item) {
        return {
          name: item.skill_code || '未命名技能',
          status: item.enabled ? (item.visibility || 'enabled') : 'disabled',
          meta: item.source_type || '',
        };
      }),
      knowledge: knowledgeBindings.map(function (item) {
        return {
          name: item.name || item.knowledge_base_id || '未命名知识库',
          status: item.status || (item.enabled ? 'enabled' : 'disabled'),
          meta: item.scope_mode || '',
        };
      }),
      memory: memory ? {
        mode: memory.mode || memory.type || '未设置',
        providerCode: _stringValue(memory.provider_code, '未设置'),
        retentionDays: memory.retention_days == null ? '未设置' : String(memory.retention_days),
        writebackEnabled: _displayFlag(memory.writeback_enabled),
        bindingVersion: memory.binding_version != null ? String(memory.binding_version) : '—',
        maxTokens: maxTokens,
      } : null,
      memoryItems: memory ? [
        { name: '模式', status: memory.mode || memory.type || '未设置' },
        { name: 'Provider', status: _stringValue(memory.provider_code, '未设置') },
        { name: '保留天数', status: memory.retention_days == null ? '未设置' : String(memory.retention_days) },
        { name: '自动写回', status: _displayFlag(memory.writeback_enabled) },
        { name: '绑定版本', status: memory.binding_version != null ? String(memory.binding_version) : '—' },
        { name: '容量上限', status: maxTokens },
      ] : [],
      usageSummary: {
        totalRuns: usageSummary.total_runs == null ? '0' : String(usageSummary.total_runs),
        totalTokens: usageSummary.total_tokens == null ? '0' : String(usageSummary.total_tokens),
        lastRunAt: _stringValue(usageSummary.last_run_at, '暂无记录'),
      },
      runSummary: data.run_summary || {},
      scheduledJobs: data.scheduled_jobs || [],
      bindingsSummary: data.bindings_summary || [],
      usageItems: [
        { name: '累计 Runs', status: usageSummary.total_runs == null ? '0' : String(usageSummary.total_runs) },
        { name: '累计 Tokens', status: usageSummary.total_tokens == null ? '0' : String(usageSummary.total_tokens) },
        { name: '最近运行', status: _stringValue(usageSummary.last_run_at, '暂无记录') },
      ],
      connectors: connectorBindings.map(function (item) {
        return {
          name: item.name || item.connector_id || '未命名连接器',
          status: item.status || (item.enabled ? 'enabled' : 'disabled'),
          meta: item.provider_code || item.connector_type || '',
          accessMode: item.access_mode || '',
        };
      }),
      recentAuditEvents: data.recent_audit_events || [],
      connectorNames: _listValue(connectorBindings, ['name', 'connector_id'], '未命名连接器'),
      skillCodes: _listValue(skills, ['skill_code'], '未命名技能'),
      knowledgeIds: _listValue(knowledgeBindings, ['name', 'knowledge_base_id'], '未命名知识库'),
    };
  }

  function _fieldRow(label, value) {
    return '<div class="aiteam-drawer__field">' +
      '<span class="aiteam-drawer__field-label">' + _escapeHtml(label) + '</span>' +
      '<span class="aiteam-drawer__field-value">' + _escapeHtml(value) + '</span>' +
      '</div>';
  }

  function _bindingList(items, emptyMsg) {
    if (!items || items.length === 0) {
      return '<p class="aiteam-drawer__desc">' + _escapeHtml(emptyMsg) + '</p>';
    }
    return '<ul class="aiteam-drawer__binding-list">' + items.map(function (item) {
      return '<li class="aiteam-drawer__binding-item">' +
        '<div>' +
        '<span class="aiteam-drawer__binding-name">' + _escapeHtml(item.name || '') + '</span>' +
        (item.meta ? '<div class="aiteam-drawer__binding-meta">' + _escapeHtml(item.meta) + '</div>' : '') +
        (item.accessMode ? '<div class="aiteam-drawer__binding-meta">访问模式: ' + _escapeHtml(item.accessMode) + '</div>' : '') +
        '</div>' +
        (item.status ? '<span class="aiteam-drawer__binding-status">' + _escapeHtml(item.status) + '</span>' : '') +
        '</li>';
    }).join('') + '</ul>';
  }

  function _bindingsSummaryMarkup(items) {
    if (!items || !items.length) return '<p class="aiteam-drawer__desc">暂无能力装配摘要</p>';
    return '<div class="aiteam-drawer__summary-grid">' + items.map(function (item) {
      return '<div class="aiteam-drawer__summary-card">' +
        '<span class="aiteam-drawer__summary-label">' + _escapeHtml(item.binding_type || '未命名分类') + '</span>' +
        '<strong class="aiteam-drawer__summary-value">' + _escapeHtml(item.count == null ? '0' : String(item.count)) + '</strong>' +
        '</div>';
    }).join('') + '</div>';
  }

  function _scheduledJobsMarkup(items) {
    if (!items || !items.length) {
      return '<p class="aiteam-drawer__desc">当前员工暂无 Loop / Scheduled Job 配置。</p>';
    }
    return '<ul class="aiteam-drawer__binding-list">' + items.map(function (item) {
      var expr = _stringValue(item.schedule_expr, '未设置');
      var goal = _stringValue(item.goal, '未设置执行目标');
      var failureText = (item.consecutive_failures == null ? '0' : String(item.consecutive_failures)) + ' / ' + (item.max_consecutive_failures == null ? '—' : String(item.max_consecutive_failures));
      return '<li class="aiteam-drawer__binding-item">' +
        '<div>' +
        '<span class="aiteam-drawer__binding-name">' + _escapeHtml(item.name || item.scheduled_job_id || '未命名任务') + '</span>' +
        '<div class="aiteam-drawer__binding-meta">Cron: ' + _escapeHtml(expr) + '</div>' +
        '<div class="aiteam-drawer__binding-meta">目标: ' + _escapeHtml(goal) + '</div>' +
        '<div class="aiteam-drawer__binding-meta">最近执行: ' + _escapeHtml(_stringValue(item.last_run_at, '暂无记录')) + ' · 最近成功: ' + _escapeHtml(_stringValue(item.last_success_at, '暂无记录')) + '</div>' +
        '<div class="aiteam-drawer__binding-meta">连续失败: ' + _escapeHtml(failureText) + ' · Runtime Job: ' + _escapeHtml(_stringValue(item.runtime_job_id, '待创建')) + '</div>' +
        '</div>' +
        '<span class="aiteam-drawer__binding-status">' + _escapeHtml(item.status || 'unknown') + '</span>' +
        '</li>';
    }).join('') + '</ul>';
  }

  function _runSummaryMarkup(summary) {
    if (!summary || !Object.keys(summary).length) {
      return '<p class="aiteam-drawer__desc">暂无运行摘要</p>';
    }
    return '<div class="aiteam-drawer__summary-grid">' +
      '<div class="aiteam-drawer__summary-card"><span class="aiteam-drawer__summary-label">最近 Run</span><strong class="aiteam-drawer__summary-value">' + _escapeHtml(_stringValue(summary.latest_run_id, '暂无')) + '</strong></div>' +
      '<div class="aiteam-drawer__summary-card"><span class="aiteam-drawer__summary-label">最近状态</span><strong class="aiteam-drawer__summary-value">' + _escapeHtml(_stringValue(summary.latest_status, '暂无')) + '</strong></div>' +
      '<div class="aiteam-drawer__summary-card"><span class="aiteam-drawer__summary-label">触发方式</span><strong class="aiteam-drawer__summary-value">' + _escapeHtml(_stringValue(summary.latest_trigger_type, '暂无')) + '</strong></div>' +
      '<div class="aiteam-drawer__summary-card"><span class="aiteam-drawer__summary-label">累计成本(分)</span><strong class="aiteam-drawer__summary-value">' + _escapeHtml(summary.total_cost_cents == null ? '0' : String(summary.total_cost_cents)) + '</strong></div>' +
      '</div>' +
      '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
      '<span class="aiteam-drawer__field-label">最近完成时间</span>' +
      '<div class="aiteam-drawer__prompt-text">' + _escapeHtml(_stringValue(summary.latest_finished_at, '暂无记录')) + '</div>' +
      '</div>';
  }

  function _recentAuditMarkup(items) {
    if (!items || !items.length) {
      return '<p class="aiteam-drawer__desc">当前员工尚无治理审计记录。</p>';
    }
    return '<ul class="aiteam-drawer__binding-list">' + items.map(function (item) {
      var payload = item && item.payload && Object.keys(item.payload).length
        ? JSON.stringify(item.payload)
        : '';
      return '<li class="aiteam-drawer__binding-item">' +
        '<div>' +
        '<span class="aiteam-drawer__binding-name">' + _escapeHtml(item.event_type || 'unknown') + '</span>' +
        '<div class="aiteam-drawer__binding-meta">操作者: ' + _escapeHtml(_stringValue(item.actor_id, 'system')) + ' · 时间: ' + _escapeHtml(_stringValue(item.created_at, '暂无记录')) + '</div>' +
        (item.request_id ? '<div class="aiteam-drawer__binding-meta">request_id: ' + _escapeHtml(item.request_id) + '</div>' : '') +
        (payload ? '<div class="aiteam-drawer__binding-meta">payload: ' + _escapeHtml(payload) + '</div>' : '') +
        '</div>' +
        '<span class="aiteam-drawer__binding-status">audit</span>' +
        '</li>';
    }).join('') + '</ul>';
  }

  function _configNotice(tabId) {
    return _configNoticeByTab[tabId] || '';
  }

  function _setConfigNotice(tabId, message) {
    _configNoticeByTab[tabId] = message || '';
  }

  function _isConfigLoading(tabId) {
    return !!_configLoadingByTab[tabId];
  }

  function _parseCommaList(value) {
    return String(value || '').split(',').map(function (item) {
      return item.replace(/^\s+|\s+$/g, '');
    }).filter(Boolean);
  }

  function _applyLocalEmployeePatch(patch) {
    if (!_employeeData || !patch) return;
    if (Object.prototype.hasOwnProperty.call(patch, 'display_name')) {
      _employeeData.displayName = _stringValue(patch.display_name, '未设置');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'model_provider')) {
      _employeeData.modelProvider = _stringValue(patch.model_provider, '未设置');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'model_name')) {
      _employeeData.modelName = _stringValue(patch.model_name, '未设置');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'prompt_system')) {
      _employeeData.systemPrompt = _stringValue(patch.prompt_system, '未设置');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'prompt_opening_message')) {
      _employeeData.openingMessage = _stringValue(patch.prompt_opening_message, '—');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'prompt_version')) {
      _employeeData.promptVersion = patch.prompt_version == null ? '—' : String(patch.prompt_version);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'prompt_behavior_rules_json')) {
      _employeeData.behaviorRuleLabels = _parseBehaviorRuleLabels(patch.prompt_behavior_rules_json);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'knowledge_base_ids')) {
      _employeeData.knowledgeIds = (patch.knowledge_base_ids || []).slice();
      _employeeData.knowledge = (_employeeData.knowledgeIds || []).map(function (knowledgeId) {
        return { name: knowledgeId, status: 'enabled', meta: 'read' };
      });
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'memory_mode') ||
        Object.prototype.hasOwnProperty.call(patch, 'memory_provider_code') ||
        Object.prototype.hasOwnProperty.call(patch, 'memory_retention_days') ||
        Object.prototype.hasOwnProperty.call(patch, 'memory_writeback_enabled')) {
      _employeeData.memory = {
        mode: Object.prototype.hasOwnProperty.call(patch, 'memory_mode') ? patch.memory_mode : (_employeeData.memory && _employeeData.memory.mode) || '未设置',
        providerCode: Object.prototype.hasOwnProperty.call(patch, 'memory_provider_code') ? _stringValue(patch.memory_provider_code, '未设置') : (_employeeData.memory && _employeeData.memory.providerCode) || '未设置',
        retentionDays: Object.prototype.hasOwnProperty.call(patch, 'memory_retention_days') ? (patch.memory_retention_days == null ? '未设置' : String(patch.memory_retention_days)) : (_employeeData.memory && _employeeData.memory.retentionDays) || '未设置',
        writebackEnabled: Object.prototype.hasOwnProperty.call(patch, 'memory_writeback_enabled') ? _displayFlag(patch.memory_writeback_enabled) : (_employeeData.memory && _employeeData.memory.writebackEnabled) || '未设置',
        bindingVersion: (_employeeData.memory && _employeeData.memory.bindingVersion) || '—',
        maxTokens: (_employeeData.memory && _employeeData.memory.maxTokens) || '未设置',
      };
      _employeeData.memoryItems = [
        { name: '模式', status: _employeeData.memory.mode },
        { name: 'Provider', status: _employeeData.memory.providerCode },
        { name: '保留天数', status: _employeeData.memory.retentionDays },
        { name: '自动写回', status: _employeeData.memory.writebackEnabled },
        { name: '绑定版本', status: _employeeData.memory.bindingVersion },
        { name: '容量上限', status: _employeeData.memory.maxTokens },
      ];
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'connector_ids')) {
      _employeeData.connectorNames = (patch.connector_ids || []).slice();
      _employeeData.connectors = (_employeeData.connectorNames || []).map(function (connectorId) {
        return { name: connectorId, status: 'enabled', meta: '', accessMode: 'invoke' };
      });
    }
    if (patch.scheduled_job) {
      var scheduledJobId = patch.scheduled_job.scheduled_job_id || (_employeeData.scheduledJobs[0] && _employeeData.scheduledJobs[0].scheduled_job_id) || 'job_local';
      _employeeData.scheduledJobs = [Object.assign({
        scheduled_job_id: scheduledJobId,
        consecutive_failures: 0,
        max_consecutive_failures: 3,
        last_run_status: null,
        last_run_at: null,
        last_success_at: null,
        runtime_job_id: '待创建',
        notification_policy: {},
      }, patch.scheduled_job)];
    }
  }

  function _saveEmployeePatch(tabId, patch, successMessage) {
    if (!_employeeData || !ns.api || !ns.api.updateEmployee || _isConfigLoading(tabId)) {
      return Promise.resolve(null);
    }
    _configLoadingByTab[tabId] = true;
    _setConfigNotice(tabId, '');
    _renderTabContent();
    return ns.api.updateEmployee(_lastEmployeeId, patch).then(function (result) {
      _configLoadingByTab[tabId] = false;
      if (!result.ok) {
        _setConfigNotice(tabId, '保存失败：' + _apiErrorMsg(result));
        _renderTabContent();
        return result;
      }
      _applyLocalEmployeePatch(patch);
      _setConfigNotice(tabId, successMessage);
      _renderTabContent();
      return result;
    });
  }

  function _configActionsMarkup(tabId, buttonLabel) {
    return '<div class="aiteam-drawer__binding-actions">' +
      '<button type="button" class="aiteam-btn" data-config-save="' + _escapeHtml(tabId) + '"' + (_isConfigLoading(tabId) ? ' disabled' : '') + '>' + buttonLabel + '</button>' +
      '</div>' +
      (_configNotice(tabId) ? '<p class="aiteam-drawer__desc">' + _escapeHtml(_configNotice(tabId)) + '</p>' : '');
  }

  function _wireConfigButtons() {
    if (!_drawer || !_drawer.querySelectorAll) return;
    var buttons = _drawer.querySelectorAll('[data-config-save]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () {
        var tabId = this.getAttribute('data-config-save');
        if (tabId === 'profile') {
          _saveEmployeePatch('profile', {
            display_name: document.getElementById('aiteam-profile-display-name-input') ? document.getElementById('aiteam-profile-display-name-input').value : '',
          }, '基础资料已保存');
        } else if (tabId === 'model') {
          _saveEmployeePatch('model', {
            model_provider: document.getElementById('aiteam-model-provider-input') ? document.getElementById('aiteam-model-provider-input').value : '',
            model_name: document.getElementById('aiteam-model-name-input') ? document.getElementById('aiteam-model-name-input').value : '',
          }, '模型配置已保存');
        } else if (tabId === 'prompt') {
          _saveEmployeePatch('prompt', {
            prompt_version: Number((document.getElementById('aiteam-prompt-version-input') || {}).value || 0) || 0,
            prompt_system: document.getElementById('aiteam-prompt-system-input') ? document.getElementById('aiteam-prompt-system-input').value : '',
            prompt_behavior_rules_json: document.getElementById('aiteam-prompt-rules-input') ? document.getElementById('aiteam-prompt-rules-input').value : '',
            prompt_opening_message: document.getElementById('aiteam-prompt-opening-input') ? document.getElementById('aiteam-prompt-opening-input').value : '',
          }, '提示词配置已保存');
        } else if (tabId === 'knowledge') {
          _saveEmployeePatch('knowledge', {
            knowledge_base_ids: _parseCommaList(document.getElementById('aiteam-knowledge-ids-input') ? document.getElementById('aiteam-knowledge-ids-input').value : ''),
          }, '知识库绑定已保存');
        } else if (tabId === 'memory') {
          _saveEmployeePatch('memory', {
            memory_mode: document.getElementById('aiteam-memory-mode-input') ? document.getElementById('aiteam-memory-mode-input').value : '',
            memory_provider_code: document.getElementById('aiteam-memory-provider-input') ? document.getElementById('aiteam-memory-provider-input').value : '',
            memory_retention_days: Number((document.getElementById('aiteam-memory-retention-input') || {}).value || 0) || null,
            memory_writeback_enabled: !!((document.getElementById('aiteam-memory-writeback-input') || {}).checked),
          }, '记忆配置已保存');
        } else if (tabId === 'connectors') {
          _saveEmployeePatch('connectors', {
            connector_ids: _parseCommaList(document.getElementById('aiteam-connector-ids-input') ? document.getElementById('aiteam-connector-ids-input').value : ''),
          }, '连接器绑定已保存');
        } else if (tabId === 'loop') {
          _saveEmployeePatch('loop', {
            scheduled_job: {
              scheduled_job_id: document.getElementById('aiteam-loop-job-id-input') ? document.getElementById('aiteam-loop-job-id-input').value : '',
              name: document.getElementById('aiteam-loop-name-input') ? document.getElementById('aiteam-loop-name-input').value : '',
              goal: document.getElementById('aiteam-loop-goal-input') ? document.getElementById('aiteam-loop-goal-input').value : '',
              schedule_expr: document.getElementById('aiteam-loop-cron-input') ? document.getElementById('aiteam-loop-cron-input').value : '',
              status: document.getElementById('aiteam-loop-status-input') ? document.getElementById('aiteam-loop-status-input').value : 'enabled',
            },
          }, 'Loop 配置已保存');
        }
      });
    }
  }

  function _renderEnterpriseSkillAssignments() {
    var assigned = _employeeData && _employeeData.skillCodes ? _employeeData.skillCodes : [];
    if (_skillInstallState === 'loading') {
      return '<p class="aiteam-drawer__desc">正在加载企业技能库...</p>';
    }
    if (_skillInstallState === 'unavailable') {
      return '<p class="aiteam-drawer__desc">企业技能库暂时不可用，请稍后重试。</p>';
    }
    if (!_enterpriseSkillInstalls.length) {
      return '<p class="aiteam-drawer__desc">企业技能库暂无已安装技能；请先前往 /admin/skills 安装。</p>';
    }
    return '<ul class="aiteam-drawer__binding-list">' + _enterpriseSkillInstalls.map(function (item) {
      var skillCode = item.skill_id || item.skill_code || item.name || '';
      var isAssigned = assigned.indexOf(skillCode) !== -1;
      var buttonText = isAssigned ? '移除授权' : '授权给员工';
      var buttonClass = isAssigned ? 'aiteam-btn aiteam-btn--secondary' : 'aiteam-btn';
      var disabled = _skillActionLoading === skillCode ? ' disabled' : '';
      return '<li class="aiteam-drawer__binding-item">' +
        '<div>' +
        '<span class="aiteam-drawer__binding-name">' + _escapeHtml(item.name || skillCode || '未命名技能') + '</span>' +
        '<div class="aiteam-drawer__binding-meta">版本 ' + _escapeHtml(item.version || '—') + ' · ' + _escapeHtml(item.source || 'custom') + '</div>' +
        '<div class="aiteam-drawer__binding-meta">企业可见性: ' + _escapeHtml(item.visibility || 'enterprise') + '</div>' +
        '</div>' +
        '<div class="aiteam-drawer__binding-actions">' +
        '<span class="aiteam-drawer__binding-status">' + (isAssigned ? '已授权' : '未授权') + '</span>' +
        '<button type="button" class="' + buttonClass + '" data-skill-code="' + _escapeHtml(skillCode) + '" data-action="' + (isAssigned ? 'remove' : 'add') + '"' + disabled + '>' + buttonText + '</button>' +
        '</div>' +
        '</li>';
    }).join('') + '</ul>';
  }

  function _wireSkillButtons() {
    if (!_drawer || !_drawer.querySelectorAll) return;
    var buttons = _drawer.querySelectorAll('[data-skill-code]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () {
        var skillCode = this.getAttribute('data-skill-code');
        var action = this.getAttribute('data-action');
        _submitSkillUpdate(skillCode, action === 'add');
      });
    }
  }

  function _statusActionsMarkup() {
    if (!_employeeData) return '';
    var status = _employeeData.status || 'active';
    var actions = [];
    if (status === 'active') {
      actions.push({ status: 'paused', label: '暂停员工' });
      actions.push({ status: 'archived', label: '解雇员工' });
    } else if (status === 'paused') {
      actions.push({ status: 'active', label: '恢复运行' });
      actions.push({ status: 'archived', label: '解雇员工' });
    }
    if (!actions.length) {
      return '<p class="aiteam-drawer__desc">当前员工已解雇。如需重新启用，请通过人才市场重新招募。</p>';
    }
    return '<div class="aiteam-drawer__binding-actions">' + actions.map(function (item) {
      var disabled = _statusActionLoading === item.status ? ' disabled' : '';
      var buttonClass = item.status === 'archived' ? 'aiteam-btn aiteam-btn--secondary' : 'aiteam-btn';
      return '<button type="button" class="' + buttonClass + '" data-status-action="' + _escapeHtml(item.status) + '"' + disabled + '>' + item.label + '</button>';
    }).join('') + '</div>';
  }

  function _wireStatusButtons() {
    if (!_drawer || !_drawer.querySelectorAll) return;
    var buttons = _drawer.querySelectorAll('[data-status-action]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () {
        var nextStatus = this.getAttribute('data-status-action');
        _submitStatusUpdate(nextStatus);
      });
    }
  }

  function _submitStatusUpdate(nextStatus) {
    if (!_employeeData || !ns.api || !ns.api.updateEmployee || !nextStatus || _statusActionLoading) return;
    _statusActionLoading = nextStatus;
    _statusNotice = '';
    _renderTabContent();
    ns.api.updateEmployee(_lastEmployeeId, { status: nextStatus }).then(function (result) {
      _statusActionLoading = '';
      if (!result.ok) {
        _statusNotice = '状态更新失败：' + _apiErrorMsg(result);
        _renderTabContent();
        return;
      }
      _employeeData.status = result.data && result.data.status ? result.data.status : nextStatus;
      _statusNotice = nextStatus === 'archived'
        ? '员工已提交解雇/归档操作'
        : (nextStatus === 'paused' ? '员工已暂停' : '员工已恢复为 active');
      _renderTabContent();
    });
  }

  function _renderTabContent() {
    var body = document.getElementById('aiteam-drawer-body');
    if (!body) return;
    if (!_employeeData) {
      body.innerHTML = '<div class="aiteam-drawer__state aiteam-drawer__state--empty"><p>未加载员工数据</p></div>';
      return;
    }

    var d = _employeeData;
    var renderers = {
      profile: function () {
        return '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">基础信息</h3>' +
          _fieldRow('姓名', d.displayName) +
          _fieldRow('员工 ID', d.employeeId) +
          _fieldRow('状态', d.status) +
          _fieldRow('岗位', d.roleName) +
          _fieldRow('在线态', d.presence) +
          _fieldRow('Profile', d.profileName) +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">编辑员工名称</span>' +
          '<input id="aiteam-profile-display-name-input" class="aiteam-input" value="' + _escapeHtml(d.displayName === '未设置' ? '' : d.displayName) + '">' +
          '</div>' +
          _configActionsMarkup('profile', '保存基础资料') +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">运行安全操作</span>' +
          '<div class="aiteam-drawer__prompt-text">可在此停用、恢复或解雇员工。停用后员工不再响应新会话；解雇为不可逆操作，请谨慎执行。</div>' +
          (_statusNotice ? '<p class="aiteam-drawer__desc">' + _escapeHtml(_statusNotice) + '</p>' : '') +
          _statusActionsMarkup() +
          '</div>' +
          '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">治理审计</h3>' +
          '<p class="aiteam-drawer__desc">展示该员工最近的治理操作记录，包括停用、恢复与周期任务调整。</p>' +
          _recentAuditMarkup(d.recentAuditEvents) +
          '</div>' +
          '</div>';
      },
      model: function () {
        return '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">模型配置</h3>' +
          _fieldRow('Provider', d.modelProvider) +
          _fieldRow('模型名称', d.modelName) +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">编辑 Provider</span>' +
          '<input id="aiteam-model-provider-input" class="aiteam-input" value="' + _escapeHtml(d.modelProvider === '未设置' ? '' : d.modelProvider) + '">' +
          '</div>' +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">编辑模型名称</span>' +
          '<input id="aiteam-model-name-input" class="aiteam-input" value="' + _escapeHtml(d.modelName === '未设置' ? '' : d.modelName) + '">' +
          '</div>' +
          _configActionsMarkup('model', '保存模型配置') +
          '</div>';
      },
      prompt: function () {
        var behavior = d.behaviorRuleLabels.length
          ? '<div class="aiteam-drawer__prompt-rules">' + d.behaviorRuleLabels.map(function (item) {
              return '<span class="aiteam-drawer__rule-chip">' + _escapeHtml(item) + '</span>';
            }).join('') + '</div>'
          : '<p class="aiteam-drawer__desc">暂无行为规则</p>';
        return '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">提示词配置</h3>' +
          _fieldRow('版本', d.promptVersion) +
          _fieldRow('开场白', d.openingMessage) +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">系统提示词</span>' +
          '<div class="aiteam-drawer__prompt-text">' + _escapeHtml(d.systemPrompt) + '</div>' +
          '</div>' +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">行为规则</span>' +
          behavior +
          '</div>' +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">版本号</span>' +
          '<input id="aiteam-prompt-version-input" class="aiteam-input" value="' + _escapeHtml(d.promptVersion === '—' ? '' : d.promptVersion) + '">' +
          '</div>' +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">系统提示词编辑</span>' +
          '<textarea id="aiteam-prompt-system-input" class="aiteam-input">' + _escapeHtml(d.systemPrompt === '未设置' ? '' : d.systemPrompt) + '</textarea>' +
          '</div>' +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">行为规则 JSON</span>' +
          '<textarea id="aiteam-prompt-rules-input" class="aiteam-input">' + _escapeHtml((d.behaviorRuleLabels || []).join(', ')) + '</textarea>' +
          '</div>' +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">开场白编辑</span>' +
          '<textarea id="aiteam-prompt-opening-input" class="aiteam-input">' + _escapeHtml(d.openingMessage === '—' ? '' : d.openingMessage) + '</textarea>' +
          '</div>' +
          _configActionsMarkup('prompt', '保存提示词') +
          '</div>';
      },
      skills: function () {
        return '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">技能授权</h3>' +
          '<p class="aiteam-drawer__desc">从企业技能库为当前员工授权或移除技能，变更立即生效并长期保留。</p>' +
          (_skillNotice ? '<p class="aiteam-drawer__desc">' + _escapeHtml(_skillNotice) + '</p>' : '') +
          _renderEnterpriseSkillAssignments() +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">当前员工技能</span>' +
          _bindingList(d.skills, '暂无已授权技能') +
          '</div>' +
          '</div>';
      },
      knowledge: function () {
        return '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">知识库绑定</h3>' +
          _bindingList(d.knowledge, '暂无已绑定知识库') +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">知识库 ID（逗号分隔）</span>' +
          '<input id="aiteam-knowledge-ids-input" class="aiteam-input" value="' + _escapeHtml((d.knowledgeIds || []).join(', ')) + '">' +
          '</div>' +
          _configActionsMarkup('knowledge', '保存知识库绑定') +
          '</div>';
      },
      memory: function () {
        return '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">记忆策略</h3>' +
          _bindingList(d.memoryItems, '暂无记忆配置') +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">记忆模式</span>' +
          '<input id="aiteam-memory-mode-input" class="aiteam-input" value="' + _escapeHtml(d.memory && d.memory.mode !== '未设置' ? d.memory.mode : '') + '">' +
          '</div>' +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">Provider Code</span>' +
          '<input id="aiteam-memory-provider-input" class="aiteam-input" value="' + _escapeHtml(d.memory && d.memory.providerCode !== '未设置' ? d.memory.providerCode : '') + '">' +
          '</div>' +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">保留天数</span>' +
          '<input id="aiteam-memory-retention-input" class="aiteam-input" value="' + _escapeHtml(d.memory && d.memory.retentionDays !== '未设置' ? d.memory.retentionDays : '') + '">' +
          '</div>' +
          '<div class="aiteam-drawer__field">' +
          '<span class="aiteam-drawer__field-label">自动写回</span>' +
          '<input id="aiteam-memory-writeback-input" type="checkbox"' + (d.memory && d.memory.writebackEnabled === '开启' ? ' checked' : '') + '>' +
          '</div>' +
          _configActionsMarkup('memory', '保存记忆配置') +
          '</div>' +
          '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">使用摘要</h3>' +
          _bindingList(d.usageItems, '暂无使用数据') +
          '</div>';
      },
      connectors: function () {
        return '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">连接器绑定</h3>' +
          _bindingList(d.connectors, '暂无已绑定连接器') +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">连接器 ID（逗号分隔）</span>' +
          '<input id="aiteam-connector-ids-input" class="aiteam-input" value="' + _escapeHtml((d.connectorNames || []).join(', ')) + '">' +
          '</div>' +
          _configActionsMarkup('connectors', '保存连接器绑定') +
          '</div>';
      },
      loop: function () {
        var job = d.scheduledJobs && d.scheduledJobs[0] ? d.scheduledJobs[0] : {};
        return '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">Loop 配置</h3>' +
          '<p class="aiteam-drawer__desc">为员工配置周期性自主任务（Loop）。员工将按设定的周期自动执行任务并产出结果。</p>' +
          _scheduledJobsMarkup(d.scheduledJobs) +
          '<input id="aiteam-loop-job-id-input" type="hidden" value="' + _escapeHtml(job.scheduled_job_id || '') + '">' +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">任务名称</span>' +
          '<input id="aiteam-loop-name-input" class="aiteam-input" value="' + _escapeHtml(job.name || '') + '">' +
          '</div>' +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">执行目标</span>' +
          '<input id="aiteam-loop-goal-input" class="aiteam-input" value="' + _escapeHtml(job.goal || '') + '">' +
          '</div>' +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">Cron</span>' +
          '<input id="aiteam-loop-cron-input" class="aiteam-input" value="' + _escapeHtml(job.schedule_expr || '') + '">' +
          '</div>' +
          '<div class="aiteam-drawer__field aiteam-drawer__field--block">' +
          '<span class="aiteam-drawer__field-label">状态</span>' +
          '<input id="aiteam-loop-status-input" class="aiteam-input" value="' + _escapeHtml(job.status || 'enabled') + '">' +
          '</div>' +
          _configActionsMarkup('loop', '保存 Loop 配置') +
          '</div>' +
          '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">运行摘要</h3>' +
          _runSummaryMarkup(d.runSummary) +
          '</div>' +
          '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">能力装配摘要</h3>' +
          _bindingsSummaryMarkup(d.bindingsSummary) +
          '</div>';
      },
    };

    body.innerHTML = (renderers[_activeTab] || renderers.profile)();
    if (_activeTab === 'skills') {
      _wireSkillButtons();
    }
    if (_activeTab === 'profile') {
      _wireStatusButtons();
    }
    _wireConfigButtons();
  }

  function _switchTab(tabId) {
    _activeTab = tabId;
    if (_drawer && _drawer.querySelectorAll) {
      var btns = _drawer.querySelectorAll('.aiteam-drawer__tab');
      for (var i = 0; i < btns.length; i++) {
        var isActive = btns[i].getAttribute('data-tab') === tabId;
        if (btns[i].classList && btns[i].classList.toggle) {
          btns[i].classList.toggle('is-active', isActive);
        } else {
          btns[i].className = btns[i].className.replace(/\bis-active\b/g, '').trim();
          if (isActive) btns[i].className = (btns[i].className + ' is-active').trim();
        }
      }
    }
    _syncDrawerPath();
    _renderTabContent();
  }

  function _apiErrorMsg(result) {
    if (result && result.status === 403) return '您没有权限访问此配置';
    if (result && result.status === 404) return '员工不存在';
    if (result && result.error) return result.error;
    if (result && typeof result.status !== 'undefined') return '请求失败 (' + result.status + ')';
    return '网络请求失败';
  }

  function _loadEnterpriseSkillInstalls() {
    if (!ns.api || !ns.api.getSkillInstalls) {
      _skillInstallState = 'unavailable';
      _renderTabContent();
      return;
    }
    _skillInstallState = 'loading';
    ns.api.getSkillInstalls().then(function (result) {
      if (!result.ok) {
        _enterpriseSkillInstalls = [];
        _skillInstallState = result.status === 501 ? 'unavailable' : 'error';
        if (result.status !== 501) {
          _skillNotice = '企业技能库加载失败：' + _apiErrorMsg(result);
        }
        _renderTabContent();
        return;
      }
      var items = result.data && result.data.items;
      _enterpriseSkillInstalls = Array.isArray(items) ? items : [];
      _skillInstallState = 'ready';
      _renderTabContent();
    });
  }

  function _submitSkillUpdate(skillCode, shouldAdd) {
    if (!_employeeData || !ns.api || !ns.api.updateEmployee || !skillCode || _skillActionLoading) return;
    _skillActionLoading = skillCode;
    _skillNotice = '';
    _renderTabContent();
    ns.api.updateEmployee(_lastEmployeeId, shouldAdd ? { skills_add: [skillCode] } : { skills_remove: [skillCode] }).then(function (result) {
      _skillActionLoading = null;
      if (!result.ok) {
        _skillNotice = '技能授权更新失败：' + _apiErrorMsg(result);
        _renderTabContent();
        return;
      }
      if (shouldAdd) _addSkillCode(skillCode);
      else _removeSkillCode(skillCode);
      _skillNotice = shouldAdd ? '已加入技能授权队列：' + skillCode : '已移除技能授权：' + skillCode;
      _renderTabContent();
    });
  }

  function _renderOverlay() {
    var overlay = _createEl('div', 'aiteam-drawer__overlay');
    overlay.addEventListener('click', close);
    return overlay;
  }

  function _renderDrawerShell() {
    var drawer = _createEl('div', 'aiteam-drawer');
    var header = _createEl('div', 'aiteam-drawer__header');
    var title = _createEl('h2', 'aiteam-drawer__title', { text: '员工配置' });
    var closeBtn = _createEl('button', 'aiteam-drawer__close', { text: '✕', 'aria-label': '关闭抽屉' });
    closeBtn.addEventListener('click', close);
    header.appendChild(title);
    header.appendChild(closeBtn);

    var tabBar = _createEl('nav', 'aiteam-drawer__tabs');
    TABS.forEach(function (tab) {
      var btn = _createEl('button', 'aiteam-drawer__tab' + (tab.id === _activeTab ? ' is-active' : ''), {
        text: tab.label,
        'data-tab': tab.id,
        type: 'button'
      });
      btn.addEventListener('click', function () { _switchTab(tab.id); });
      tabBar.appendChild(btn);
    });

    var body = _createEl('div', 'aiteam-drawer__body');
    body.setAttribute('id', 'aiteam-drawer-body');

    drawer.appendChild(header);
    drawer.appendChild(tabBar);
    drawer.appendChild(body);
    return drawer;
  }

  function open(employeeId, options) {
    options = options || {};
    if (!employeeId || !_container || !ns.api || !ns.api.getEmployee) return;
    var requestedTab = _findTab(options.tab) ? options.tab : 'profile';
    _activeTab = requestedTab;
    _employeeData = null;
    _lastEmployeeId = employeeId;
    _enterpriseSkillInstalls = [];
    _skillInstallState = 'idle';
    _skillNotice = '';
    _skillActionLoading = null;
    _statusNotice = '';
    _statusActionLoading = '';
    _configNoticeByTab = {};
    _configLoadingByTab = {};

    close();
    _suppressHistorySync = options.syncUrl === false;
    if (window.location && window.location.pathname && window.location.pathname.indexOf('/admin/employees/') !== 0) {
      _suppressHistorySync = false;
    }

    _overlay = _renderOverlay();
    _drawer = _renderDrawerShell();
    _container.appendChild(_overlay);
    _container.appendChild(_drawer);

    var body = document.getElementById('aiteam-drawer-body');
    if (body) body.innerHTML = '<div class="aiteam-drawer__state aiteam-drawer__state--loading"><p>加载员工配置...</p></div>';

    ns.api.getEmployee(employeeId).then(function (result) {
      if (!result.ok) {
        if (body) body.innerHTML = '<div class="aiteam-drawer__state aiteam-drawer__state--error"><p>' + _escapeHtml(_apiErrorMsg(result)) + '</p></div>';
        _suppressHistorySync = false;
        return;
      }
      _employeeData = normalizeEmployeePayload(result.data);
      _syncDrawerPath();
      _suppressHistorySync = false;
      _renderTabContent();
      _loadEnterpriseSkillInstalls();
    });
  }

  function close() {
    if (_overlay && _overlay.remove) _overlay.remove();
    if (_drawer && _drawer.remove) _drawer.remove();
    _overlay = null;
    _drawer = null;
    _employeeData = null;
    _activeTab = 'profile';
    _suppressHistorySync = false;
  }

  function init(container) {
    _container = container || document.body;
  }

  ns.pages.adminEmployeeDrawer = {
    TABS: TABS,
    init: init,
    open: open,
    close: close,
    normalizeEmployeePayload: normalizeEmployeePayload,
    __test: {
      normalizeEmployeePayload: normalizeEmployeePayload,
      saveProfileConfig: function (patch) { return _saveEmployeePatch('profile', patch, '基础资料已保存'); },
      saveModelConfig: function (patch) { return _saveEmployeePatch('model', patch, '模型配置已保存'); },
      savePromptConfig: function (patch) { return _saveEmployeePatch('prompt', patch, '提示词配置已保存'); },
      saveKnowledgeConfig: function (patch) { return _saveEmployeePatch('knowledge', patch, '知识库绑定已保存'); },
      saveMemoryConfig: function (patch) { return _saveEmployeePatch('memory', patch, '记忆配置已保存'); },
      saveConnectorConfig: function (patch) { return _saveEmployeePatch('connectors', patch, '连接器绑定已保存'); },
      saveScheduledJobConfig: function (patch) { return _saveEmployeePatch('loop', patch, 'Loop 配置已保存'); },
    },
  };
}(window.aiteam));
