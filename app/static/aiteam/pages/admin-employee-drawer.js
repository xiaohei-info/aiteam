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

  function _renderEnterpriseSkillAssignments() {
    var assigned = _employeeData && _employeeData.skillCodes ? _employeeData.skillCodes : [];
    if (_skillInstallState === 'loading') {
      return '<p class="aiteam-drawer__desc">正在加载企业技能库...</p>';
    }
    if (_skillInstallState === 'unavailable') {
      return '<p class="aiteam-drawer__desc">当前分支未接入 /api/team/skills/installs，技能市场接口就绪后可直接在此授权。</p>';
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
      return '<p class="aiteam-drawer__desc">当前员工已归档；如需重新启用，请等待后端补充 rehire / reprovision 契约。</p>';
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
          '<span class="aiteam-drawer__field-label">运行安全操作</span>' +
          '<div class="aiteam-drawer__prompt-text">通过 PATCH /api/team/employees/{id} 提交变更。当前支持字段：display_name、status、skills_add/skills_remove、model_provider、model_name、prompt_version、prompt_system/prompt_behavior_rules_json/prompt_opening_message、memory_mode/memory_provider_code/memory_retention_days/memory_writeback_enabled、knowledge_base_ids、connector_ids、scheduled_job/scheduled_job_action。</div>' +
          (_statusNotice ? '<p class="aiteam-drawer__desc">' + _escapeHtml(_statusNotice) + '</p>' : '') +
          _statusActionsMarkup() +
          '</div>' +
          '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">治理审计</h3>' +
          '<p class="aiteam-drawer__desc">最近治理动作直接来自 /api/team/employees/{id} 返回的 recent_audit_events，可核对停用/恢复/Loop 调整是否已落库。</p>' +
          _recentAuditMarkup(d.recentAuditEvents) +
          '</div>' +
          '</div>';
      },
      model: function () {
        return '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">模型配置</h3>' +
          _fieldRow('Provider', d.modelProvider) +
          _fieldRow('模型名称', d.modelName) +
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
          '</div>';
      },
      skills: function () {
        return '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">技能授权</h3>' +
          '<p class="aiteam-drawer__desc">从企业技能库授权技能给当前员工，通过 PATCH /api/team/employees/{id} 的 skills_add / skills_remove 提交并持久化技能绑定；刷新页面后，已授权技能仍会保留。</p>' +
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
          '</div>';
      },
      memory: function () {
        return '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">记忆策略</h3>' +
          _bindingList(d.memoryItems, '暂无记忆配置') +
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
          '</div>';
      },
      loop: function () {
        return '<div class="aiteam-drawer__section">' +
          '<h3 class="aiteam-drawer__section-title">Loop 配置</h3>' +
          '<p class="aiteam-drawer__desc">Scheduled Job 由 /api/team/employees/{id} 聚合返回，修改时通过 scheduled_job / scheduled_job_action PATCH 字段提交。</p>' +
          _scheduledJobsMarkup(d.scheduledJobs) +
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
    },
  };
}(window.aiteam));
