window.aiteam = window.aiteam || {};

(function registerOrgPage(ns) {
  ns.pages = ns.pages || {};

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function firstString() {
    for (var i = 0; i < arguments.length; i += 1) {
      var value = arguments[i];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return '';
  }

  function firstObject() {
    for (var i = 0; i < arguments.length; i += 1) {
      var value = arguments[i];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
      }
    }
    return null;
  }

  function getDepartmentName(department) {
    return firstString(department.name, department.department_name, department.display_name, department.title) || '未命名部门';
  }

  function getDepartmentId(department) {
    return firstString(department.id, department.department_id, department.code, getDepartmentName(department));
  }

  function getDepartmentChildren(department) {
    var keys = ['children', 'child_departments', 'departments', 'nodes', 'items'];
    for (var i = 0; i < keys.length; i += 1) {
      var value = department && department[keys[i]];
      if (Array.isArray(value)) {
        return value.filter(function (item) { return item && typeof item === 'object'; });
      }
    }
    return [];
  }

  function getDepartmentMembers(department) {
    var keys = ['members', 'assignments', 'employees', 'member_assignments'];
    for (var i = 0; i < keys.length; i += 1) {
      var value = department && department[keys[i]];
      if (Array.isArray(value)) {
        return value.filter(function (item) { return item && typeof item === 'object'; });
      }
    }
    return [];
  }

  function getPayloadDepartments(payload) {
    if (Array.isArray(payload)) {
      return payload.filter(function (item) { return item && typeof item === 'object'; });
    }
    var keys = ['departments', 'department_tree', 'tree', 'items', 'nodes'];
    for (var i = 0; i < keys.length; i += 1) {
      var value = payload && payload[keys[i]];
      if (Array.isArray(value)) {
        return value.filter(function (item) { return item && typeof item === 'object'; });
      }
    }
    return [];
  }

  function getUnassignedMembers(payload) {
    var keys = ['assignments', 'employee_assignments', 'members'];
    for (var i = 0; i < keys.length; i += 1) {
      var value = payload && payload[keys[i]];
      if (Array.isArray(value)) {
        return value.filter(function (item) { return item && typeof item === 'object'; });
      }
    }
    return [];
  }

  function getMemberName(member) {
    var employee = firstObject(member.employee, member.profile, member.user);
    return firstString(
      member.display_name,
      member.name,
      member.employee_name,
      employee && employee.display_name,
      employee && employee.name
    ) || '未命名成员';
  }

  function getMemberRole(member) {
    return firstString(member.role, member.title, member.job_title, member.assignment_title);
  }

  function getPresence(member) {
    var presence = firstString(member.presence_label, member.presence, member.status, member.availability);
    return presence || '状态未知';
  }

  function presenceLabel(presence) {
    var value = firstString(presence).toLowerCase();
    if (value === 'online') return '在线';
    if (value === 'offline') return '离线';
    if (value === 'busy') return '繁忙';
    return firstString(presence) || '状态未知';
  }

  function memberRoleGlyph(role) {
    var value = firstString(role).toLowerCase();
    if (value.indexOf('营销') !== -1 || value.indexOf('市场') !== -1) return '🎯';
    if (value.indexOf('内容') !== -1) return '📢';
    if (value.indexOf('技术') !== -1 || value.indexOf('工程') !== -1 || value.indexOf('研发') !== -1) return '💻';
    if (value.indexOf('财务') !== -1) return '📊';
    if (value.indexOf('研究') !== -1 || value.indexOf('ai') !== -1) return '🧠';
    return '👤';
  }

  function getAssignmentLabel(member, departmentName) {
    var assignment = firstObject(member.assignment, member.org_assignment);
    return firstString(
      member.assignment_label,
      member.assignment_name,
      member.department_name,
      assignment && assignment.department_name,
      departmentName
    ) || '未分配';
  }

  function countMembers(departments) {
    return toArray(departments).reduce(function (total, department) {
      return total + getDepartmentMembers(department).length + countMembers(getDepartmentChildren(department));
    }, 0);
  }

  function countDepartments(departments) {
    return toArray(departments).reduce(function (total, department) {
      return total + 1 + countDepartments(getDepartmentChildren(department));
    }, 0);
  }

  function hasVisibleOrgData(payload, departments, unassignedMembers) {
    return departments.length > 0 || unassignedMembers.length > 0;
  }

  function renderState(main, title, body, tone) {
    main.innerHTML = [
      '<section class="aiteam-shell__panel aiteam-org aiteam-org--state">',
      '<p class="aiteam-shell__panel-kicker">组织架构</p>',
      '<h2 class="aiteam-shell__panel-title">' + escapeHtml(title) + '</h2>',
      '<p class="aiteam-shell__panel-body" data-tone="' + escapeHtml(tone || 'neutral') + '">' + escapeHtml(body) + '</p>',
      '</section>'
    ].join('');
  }

  function renderEditableAssignment(member) {
    var canEdit = member && member.can_edit === true;
    var assignmentId = firstString(member.assignment_id, member.id);
    var fieldName = firstString(member.patch_field, member.department_field);
    var choices = toArray(member.department_choices || member.available_departments || member.department_options);
    if (!canEdit || !assignmentId || !fieldName || choices.length === 0) {
      return '';
    }

    var selectedValue = firstString(member.department_id, member.current_department_id);
    var optionMarkup = choices.map(function (choice) {
      var value = firstString(choice.id, choice.department_id, choice.value);
      var label = firstString(choice.name, choice.label, choice.department_name, value);
      var selected = value && value === selectedValue ? ' selected' : '';
      return '<option value="' + escapeHtml(value) + '"' + selected + '>' + escapeHtml(label) + '</option>';
    }).join('');

    return [
      '<div class="aiteam-org__editor" data-org-editor="' + escapeHtml(assignmentId) + '">',
      '<label class="aiteam-org__editor-label" for="org-assignment-' + escapeHtml(assignmentId) + '">调整归属</label>',
      '<div class="aiteam-org__editor-row">',
      '<select id="org-assignment-' + escapeHtml(assignmentId) + '" data-org-assignment-select="' + escapeHtml(assignmentId) + '" data-org-patch-field="' + escapeHtml(fieldName) + '">',
      optionMarkup,
      '</select>',
      '<button type="button" data-org-assignment-save="' + escapeHtml(assignmentId) + '">更新</button>',
      '</div>',
      '<p class="aiteam-org__hint" data-org-assignment-status="' + escapeHtml(assignmentId) + '"></p>',
      '</div>'
    ].join('');
  }

  function renderMember(member, departmentName) {
    var role = getMemberRole(member);
    var presence = getPresence(member);
    return [
      '<li class="aiteam-org__member">',
      '<div class="aiteam-org__member-main">',
      '<span class="aiteam-org__badge">' + escapeHtml(memberRoleGlyph(role)) + '</span>',
      '<strong class="aiteam-org__member-name">' + escapeHtml(getMemberName(member)) + '</strong>',
      '<span class="aiteam-org__badge">' + escapeHtml(presenceLabel(presence)) + '</span>',
      '</div>',
      '<div class="aiteam-org__member-meta">',
      '<span class="aiteam-org__member-assignment">归属：' + escapeHtml(getAssignmentLabel(member, departmentName)) + '</span>',
      role ? '<span class="aiteam-org__member-role">岗位：' + escapeHtml(role) + '</span>' : '',
      '<span class="aiteam-org__member-role">原始状态：' + escapeHtml(presence) + '</span>',
      '</div>',
      renderEditableAssignment(member),
      '</li>'
    ].join('');
  }

  function renderDepartment(department) {
    var name = getDepartmentName(department);
    var members = getDepartmentMembers(department);
    var children = getDepartmentChildren(department);
    var description = firstString(department.description, department.summary, department.note);

    return [
      '<article class="aiteam-org__department" data-department-id="' + escapeHtml(getDepartmentId(department)) + '">',
      '<header class="aiteam-org__department-header">',
      '<h3 class="aiteam-org__department-title">' + escapeHtml(name) + '</h3>',
      '<span class="aiteam-org__department-count">' + members.length + ' 位数字员工</span>',
      '</header>',
      description ? '<p class="aiteam-org__department-description">' + escapeHtml(description) + '</p>' : '',
      members.length ? '<ul class="aiteam-org__member-list">' + members.map(function (member) { return renderMember(member, name); }).join('') + '</ul>' : '<p class="aiteam-org__empty-hint">当前部门暂无成员。</p>',
      children.length ? '<div class="aiteam-org__children">' + children.map(renderDepartment).join('') + '</div>' : '',
      '</article>'
    ].join('');
  }

  function attachEditors(main) {
    if (!main || typeof main.querySelectorAll !== 'function' || !ns.api || !ns.api.updateOrgAssignment) {
      return;
    }

    var buttons = main.querySelectorAll('[data-org-assignment-save]');
    buttons.forEach(function (button) {
      button.addEventListener('click', function () {
        var assignmentId = button.getAttribute('data-org-assignment-save');
        var select = main.querySelector('[data-org-assignment-select="' + assignmentId + '"]');
        var status = main.querySelector('[data-org-assignment-status="' + assignmentId + '"]');
        if (!select) {
          return;
        }
        var fieldName = select.getAttribute('data-org-patch-field');
        if (!fieldName) {
          return;
        }

        var body = {};
        body[fieldName] = select.value;
        if (status) {
          status.textContent = '正在更新归属...';
        }

        ns.api.updateOrgAssignment(assignmentId, body).then(function (result) {
          if (result && result.ok) {
            if (status) {
              status.textContent = '归属已更新。';
            }
            loadOrg(main);
            return;
          }
          if (status) {
            status.textContent = (result && result.error) ? result.error : '归属更新失败';
          }
        }).catch(function () {
          if (status) {
            status.textContent = '归属更新失败';
          }
        });
      });
    });
  }

  function renderLegend() {
    return [
      '<div class="aiteam-card aiteam-card--flat">',
      '<div class="aiteam-card__row"><strong>状态图例</strong><span class="aiteam-inline-note">在线 / 离线 / 繁忙</span></div>',
      '<div class="aiteam-card__meta"><span>在线 / 离线 / 繁忙</span><span>拖拽调整层级或使用下方等价归属调整控件</span></div>',
      '</div>'
    ].join('');
  }

  function renderDeptSummary(departments, unassignedMembers) {
    var primary = departments[0] || null;
    if (!primary) {
      return '<div class="aiteam-inline-empty">暂无部门详情</div>';
    }
    var primaryMembers = getDepartmentMembers(primary);
    var primaryChildren = getDepartmentChildren(primary);
    return [
      '<div class="aiteam-card">',
      '<div class="aiteam-card__row"><strong>部门详情</strong><span class="aiteam-inline-note">' + escapeHtml(getDepartmentName(primary)) + '</span></div>',
      '<div class="aiteam-card__meta"><span>当前主部门</span><span>' + escapeHtml(getDepartmentName(primary)) + '</span></div>',
      '<div class="aiteam-card__meta"><span>数字员工</span><span>' + primaryMembers.length + ' 位</span></div>',
      '<div class="aiteam-card__meta"><span>子部门</span><span>' + primaryChildren.length + ' 个</span></div>',
      '<div class="aiteam-card__meta"><span>待分配成员</span><span>' + unassignedMembers.length + ' 位</span></div>',
      primary.description ? '<div class="aiteam-card__meta"><span>说明</span><span>' + escapeHtml(primary.description) + '</span></div>' : '',
      '</div>'
    ].join('');
  }

  function renderOrgNode(name, role, glyph, rootClass) {
    return '<div class="aiteam-org__node' + (rootClass ? ' is-root' : '') + '">' +
      '<div class="aiteam-org__node-avatar">' + escapeHtml(glyph || '🤖') + '</div>' +
      '<div><div class="aiteam-org__node-name">' + escapeHtml(name) + '</div>' +
      '<div class="aiteam-org__node-role">' + escapeHtml(role || '') + '</div></div></div>';
  }

  function renderOrgChart(departments) {
    var rootHtml = '<div class="aiteam-org__level">' + renderOrgNode('企业团队', '组织根节点', '🏢', true) + '</div>' +
      '<div class="aiteam-org__line-v"></div>';
    var deptNodes = departments.map(function (dept) {
      var name = getDepartmentName(dept);
      var members = getDepartmentMembers(dept);
      var memberHtml = members.map(function (m) {
        return renderOrgNode(getMemberName(m), getMemberRole(m) || presenceLabel(getPresence(m)), '🧑‍💼', false);
      }).join('');
      return '<div style="display:flex;flex-direction:column;align-items:center;gap:0;">' +
        renderOrgNode(name, members.length + ' 位成员', '🗂️', false) +
        (memberHtml ? '<div class="aiteam-org__line-v"></div><div class="aiteam-org__level">' + memberHtml + '</div>' : '') +
        '</div>';
    }).join('');
    return '<div class="aiteam-org__chart">' + rootHtml + '<div class="aiteam-org__level">' + deptNodes + '</div></div>';
  }

  function renderOrg(main, payload) {
    var departments = getPayloadDepartments(payload);
    var unassignedMembers = getUnassignedMembers(payload);
    if (!hasVisibleOrgData(payload, departments, unassignedMembers)) {
      renderState(main, '暂无组织信息', '当前企业还没有可展示的部门或成员归属。', 'empty');
      return;
    }

    var totalMembers = countMembers(departments) + unassignedMembers.length;
    var totalDepartments = countDepartments(departments);
    var panels = departments.map(renderDepartment).join('');
    if (unassignedMembers.length) {
      panels += [
        '<article class="aiteam-org__department aiteam-org__department--unassigned">',
        '<header class="aiteam-org__department-header">',
        '<h3 class="aiteam-org__department-title">待分配成员</h3>',
        '<span class="aiteam-org__department-count">' + unassignedMembers.length + ' 位数字员工</span>',
        '</header>',
        '<ul class="aiteam-org__member-list">',
        unassignedMembers.map(function (member) { return renderMember(member, '待分配'); }).join(''),
        '</ul>',
        '</article>'
      ].join('');
    }

    main.innerHTML = [
      '<section class="aiteam-shell__panel aiteam-org">',
      '<p class="aiteam-shell__panel-kicker">组织架构</p>',
      '<div class="aiteam-panel__header"><h2 class="aiteam-shell__panel-title">组织架构</h2><button type="button" class="aiteam-btn aiteam-btn--secondary" disabled>+ 新建部门</button></div>',
      '<p class="aiteam-shell__panel-body">查看部门树、数字员工归属与在线状态；当前共享契约已支持读取组织树与等价归属调整，新增部门/右键治理仍保留为显式降级提示。</p>',
      '<div class="aiteam-shell__meta">',
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">部门数量</span><span class="aiteam-shell__meta-value">' + totalDepartments + '</span></div>',
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">成员可见数</span><span class="aiteam-shell__meta-value">' + totalMembers + '</span></div>',
      '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">拖拽调整层级</span><span class="aiteam-shell__meta-value">当前以 PATCH 等价交互承接</span></div>',
      '</div>',
      '<div class="aiteam-grid aiteam-grid--chat">',
      '<section class="aiteam-panel">' + renderLegend() + renderOrgChart(departments) + '</section>',
      '<section class="aiteam-panel">' + renderDeptSummary(departments, unassignedMembers) + '</section>',
      '</div>',
      '</section>'
    ].join('');

    attachEditors(main);
  }

  function loadOrg(main) {
    renderState(main, '组织架构加载中', '正在同步部门树与成员归属...', 'loading');
    return ns.api.getOrgTree().then(function (result) {
      if (result && result.status === 403) {
        renderState(main, '无权查看组织架构', '当前账号没有查看部门树与成员归属的权限。', 'permission');
        return;
      }
      if (!result || !result.ok) {
        renderState(main, '组织架构加载失败', (result && result.error) ? result.error : '请稍后重试。', 'error');
        return;
      }
      renderOrg(main, result.data || {});
    }).catch(function () {
      renderState(main, '组织架构加载失败', '请稍后重试。', 'error');
    });
  }

  ns.pages.appOrg = {
    init: function (main) {
      if (!main) {
        return Promise.resolve();
      }
      if (!ns.api || typeof ns.api.getOrgTree !== 'function') {
        renderState(main, '组织架构不可用', '当前页面缺少 Team Panel 组织接口客户端。', 'error');
        return Promise.resolve();
      }
      return loadOrg(main);
    }
  };

  ns.pages.appOrg._renderOrg = renderOrg;
}(window.aiteam));
