window.aiteam = window.aiteam || {};

(function registerWorkbenchPage(ns) {
  ns.pages = ns.pages || {};
  var escapeHtml = (ns.util && ns.util.escapeHtml) || function (value) { return String(value == null ? '' : value); };

  function cardLink(href, label, note) {
    return '<a class="aiteam-card-link" href="' + href + '">' +
      '<span class="aiteam-card-link__label">' + escapeHtml(label) + '</span>' +
      '<span class="aiteam-card-link__note">' + escapeHtml(note || '') + '</span>' +
      '</a>';
  }

  function employeeCard(employee) {
    var chatHref = employee.conversation_id ? '/app/chat/' + encodeURIComponent(employee.conversation_id) : '/admin/employees';
    return '<article class="aiteam-card">' +
      '<div class="aiteam-card__row"><div><h3 class="aiteam-card__title">' + escapeHtml(employee.display_name || employee.employee_id || '未命名员工') + '</h3>' +
      '<p class="aiteam-card__sub">' + escapeHtml(employee.role_name || '待配置岗位') + '</p></div>' +
      '<span class="aiteam-badge">' + escapeHtml(employee.status || employee.presence || 'idle') + '</span></div>' +
      '<p class="aiteam-card__body">' + escapeHtml(employee.last_message_preview || '暂无最近消息') + '</p>' +
      '<div class="aiteam-card__meta"><span>未读 ' + escapeHtml(employee.unread_count || 0) + '</span><span>' + escapeHtml(employee.presence || 'idle') + '</span></div>' +
      '<div class="aiteam-action-row">' +
      cardLink(chatHref, employee.conversation_id ? '继续对话' : '去配置员工', employee.conversation_id ? '打开私聊' : '企业后台') +
      cardLink('/admin/employees', '员工管理', '绑定技能 / 知识 / 记忆') +
      '</div>' +
      '</article>';
  }

  function groupCard(group) {
    var href = group.conversation_id ? '/app/group/' + encodeURIComponent(group.conversation_id) : '/app/group';
    return '<article class="aiteam-card aiteam-card--group">' +
      '<div class="aiteam-card__row"><div><h3 class="aiteam-card__title">' + escapeHtml(group.title || '未命名协作组') + '</h3>' +
      '<p class="aiteam-card__sub">成员 ' + escapeHtml(group.member_count || 0) + ' · 运行中 ' + escapeHtml(group.running_count || 0) + '</p></div>' +
      '<span class="aiteam-badge">群聊</span></div>' +
      '<p class="aiteam-card__body">' + escapeHtml(group.last_message_preview || '暂无群聊动态') + '</p>' +
      '<div class="aiteam-action-row">' + cardLink(href, '打开群聊', '查看时间线') + '</div>' +
      '</article>';
  }

  function renderWorkbench(container, data) {
    var employees = Array.isArray(data.employees) ? data.employees : [];
    var groups = Array.isArray(data.groups) ? data.groups : [];
    var enterprise = data.enterprise || {};
    var digest = data.office_digest || {};

    if (!enterprise || !employees.length) {
      ns.states.renderEmpty(
        container,
        '你还没有数字员工，先去人才市场招募第一位成员。',
        '<div class="aiteam-action-row"><a class="aiteam-button" href="/app/marketplace">前往人才市场</a></div>'
      );
      return;
    }

    container.innerHTML =
      '<section class="aiteam-page">' +
      '<div class="aiteam-page__hero">' +
      '<div><p class="aiteam-page__eyebrow">P02 · 工作台</p><h2 class="aiteam-page__title">' + escapeHtml(enterprise.name || '企业工作台') + '</h2>' +
      '<p class="aiteam-page__desc">聚合员工、群聊和办公室动态入口，全部来自 Team Panel 北向工作台聚合接口。</p></div>' +
      '<div class="aiteam-hero-actions">' +
      '<a class="aiteam-button" href="/app/marketplace">招募新成员</a>' +
      '<a class="aiteam-button aiteam-button--ghost" href="/app/org">查看组织架构</a>' +
      '</div></div>' +
      '<div class="aiteam-metric-grid">' +
      '<article class="aiteam-metric"><span class="aiteam-metric__label">在线员工</span><strong class="aiteam-metric__value">' + escapeHtml(digest.online_employee_count || employees.length) + '</strong></article>' +
      '<article class="aiteam-metric"><span class="aiteam-metric__label">运行中任务</span><strong class="aiteam-metric__value">' + escapeHtml(digest.running_task_count || 0) + '</strong></article>' +
      '<article class="aiteam-metric"><span class="aiteam-metric__label">群聊协作</span><strong class="aiteam-metric__value">' + escapeHtml(groups.length) + '</strong></article>' +
      '<article class="aiteam-metric"><span class="aiteam-metric__label">快捷入口</span><strong class="aiteam-metric__value">4</strong></article>' +
      '</div>' +
      '<div class="aiteam-grid aiteam-grid--split">' +
      '<section class="aiteam-panel"><div class="aiteam-panel__header"><h3>员工私聊入口</h3><a href="/admin/employees">去后台配置</a></div>' + employees.map(employeeCard).join('') + '</section>' +
      '<section class="aiteam-panel"><div class="aiteam-panel__header"><h3>协作与导航</h3><a href="/app/office">办公室动态</a></div>' +
      '<div class="aiteam-action-grid">' +
      cardLink('/app/office', '办公室动态', '查看 Presence 点位') +
      cardLink('/app/org', '组织架构', '部门与岗位映射') +
      cardLink('/admin/employees', '员工配置', '模型 / 技能 / 知识') +
      cardLink('/app/marketplace', '人才市场', '继续招募') +
      '</div>' +
      '<div class="aiteam-stack">' + (groups.length ? groups.map(groupCard).join('') : '<div class="aiteam-inline-empty">还没有群聊协作会话，先在群聊页创建协作组。</div>') + '</div>' +
      '</section>' +
      '</div>' +
      '</section>';
  }

  ns.pages.appWorkbench = {
    render: renderWorkbench,
    init: function (container) {
      if (!container) return;
      ns.states.renderLoading(container, '加载工作台聚合视图...');
      ns.api.getWorkbench().then(function (result) {
        if (!result.ok) {
          ns.states.handleApiResult(result, container, function () {});
          return;
        }
        renderWorkbench(container, result.data || {});
      });
    },
  };
}(window.aiteam));
