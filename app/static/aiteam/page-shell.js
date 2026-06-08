window.aiteam = window.aiteam || {};

(function registerPageShell(ns) {
  // ── Full navigation catalog ──
  var FULL_SECTION_PAGES = {
    app: [
      { label: '工作台',    href: '/app/workbench',   note: 'Workbench' },
      { label: '人才市场',  href: '/app/marketplace', note: 'Talent Market' },
      { label: '对话',      href: '/app/chat',        note: 'Chat' },
      { label: '群聊',      href: '/app/group',       note: 'Group' },
      { label: '知识库',    href: '/app/knowledge',   note: 'Knowledge' },
      { label: '组织架构',  href: '/app/org',         note: 'Org' },
      { label: '办公室',    href: '/app/office',      note: 'Office' },
    ],
    admin: [
      { label: '员工',      href: '/admin/employees',        note: 'Employees' },
      { label: '方案',      href: '/admin/solutions',        note: 'Solutions' },
      { label: '技能',      href: '/admin/skills',           note: 'Skills' },
      { label: '记忆',      href: '/admin/memories',         note: 'Memories' },
      { label: '连接器',    href: '/admin/connectors',       note: 'Connectors' },
      { label: '费用',      href: '/admin/billing/usage',    note: 'Billing' },
      { label: '充值',      href: '/admin/billing/recharge', note: 'Recharge' },
      { label: '设置',      href: '/admin/settings',         note: 'Settings' },
    ],
    system: [
      { label: '企业',      href: '/system/accounts',   note: 'Enterprises' },
      { label: '专家',      href: '/system/templates',  note: 'Templates' },
      { label: '方案',      href: '/system/solutions',  note: 'Solutions' },
      { label: '财务',      href: '/system/finance',    note: 'Finance' },
      { label: '健康',      href: '/system/health',     note: 'Health' },
    ],
  };

  var SECTION_TITLES = {
    app: { title: '工作台', subtitle: '企业前台' },
    admin: { title: '企业后台', subtitle: '治理与配置' },
    system: { title: '系统后台', subtitle: '平台运营' },
  };

  // ── Role-aware nav filtering ──
  function _filteredNavItems(section) {
    var role = ns.role ? ns.role.getActiveRole() : '';
    if (!role || !ns.role.visibleNavItems) {
      // No role set — show all items (legacy behavior)
      return FULL_SECTION_PAGES[section] || FULL_SECTION_PAGES.app;
    }
    return ns.role.visibleNavItems(role, section);
  }

  // ── Role-aware section visibility ──
  function _isSectionVisible(section) {
    if (section === 'app') return true;  // App section always visible
    var role = ns.role ? ns.role.getActiveRole() : '';
    if (!role || !ns.role.visibleNavSections) return true;
    var visibility = ns.role.visibleNavSections(role);
    return visibility[section] !== false;
  }

  function _renderPermissionDenied(container) {
    if (!container) return;
    if (ns.states && ns.states.renderPermissionDenied) {
      ns.states.renderPermissionDenied(container);
      return;
    }
    container.innerHTML = '<div class="aiteam-state aiteam-state-denied"><p>您没有权限访问此内容</p></div>';
  }

  function _hasPathAccess(pathname, role) {
    if (!pathname || !role || !ns.role || !ns.role.hasPermission) return true;
    if (pathname.indexOf('/admin/employees') === 0) return ns.role.hasPermission(role, 'manage_employees');
    if (pathname.indexOf('/admin/connectors') === 0) return ns.role.hasPermission(role, 'manage_connectors');
    if (pathname.indexOf('/admin/billing') === 0) return ns.role.hasPermission(role, 'view_billing');
    if (pathname.indexOf('/system/') === 0) return ns.role.hasPermission(role, 'system_read');
    return true;
  }

  ns.shell = {
    matchPath: function (pathname) {
      if (!pathname) return null;
      if (pathname === '/app' || pathname.indexOf('/app/') === 0) return 'app';
      if (pathname === '/admin' || pathname.indexOf('/admin/') === 0) return 'admin';
      if (pathname === '/system' || pathname.indexOf('/system/') === 0) return 'system';
      return null;
    },

    init: function (route) {
      var section = route;
      if (route.indexOf('/') === 0 && route.indexOf('/', 1) !== -1) {
        section = route.split('/')[1];
      }
      if (!FULL_SECTION_PAGES[section]) section = 'app';

      var titlebar = document.querySelector('.app-titlebar');
      if (titlebar) titlebar.style.display = 'none';

      if (typeof bodyClassManager !== 'undefined' && bodyClassManager.add) {
        bodyClassManager.add('aiteam-shell-active');
      } else if (document.body && document.body.classList) {
        document.body.classList.add('aiteam-shell-active');
      }

      var shell = document.getElementById('aiteam-app');
      if (shell) shell.hidden = false;

      var layout = document.querySelector('.layout');
      if (layout) layout.style.display = 'none';

      var toast = document.getElementById('toast');
      if (toast) toast.style.display = 'none';

      var titleEl = document.getElementById('aiteam-shell-title');
      if (titleEl) {
        var info = SECTION_TITLES[section] || SECTION_TITLES.app;
        titleEl.textContent = info.title;
      }

      var subtitleEl = document.getElementById('aiteam-shell-subtitle');
      if (subtitleEl) {
        var sinfo = SECTION_TITLES[section] || SECTION_TITLES.app;
        subtitleEl.textContent = sinfo.subtitle;
      }

      var currentPath = window.location.pathname;
      var nav = document.getElementById('aiteam-nav');
      if (nav) {
        // ── Role-aware navigation ──
        var pages = _filteredNavItems(section);
        nav.innerHTML = pages.map(function (p) {
          var activeClass = (currentPath === p.href || currentPath.indexOf(p.href + '/') === 0)
            ? ' is-active'
            : '';
          return (
            '<a href="' + p.href + '" class="aiteam-shell__link' + activeClass + '">' +
            '<span class="aiteam-shell__link-label">' + p.label + '</span>' +
            '<span class="aiteam-shell__link-note">' + p.note + '</span>' +
            '</a>'
          );
        }).join('');
      }

      var main = document.getElementById('aiteam-main');
      if (!_isSectionVisible(section) || !_hasPathAccess(currentPath, ns.role ? ns.role.getActiveRole() : '')) {
        _renderPermissionDenied(main);
        return;
      }

      // ── Dynamic page loading ──
      var main = document.getElementById('aiteam-main');
      if (main) {
        var pathToModule = {};

        pathToModule['/app/org'] = 'app-org.js';
        pathToModule['/app/office'] = 'office.js';
        pathToModule['/app/knowledge'] = 'knowledge.js';
        pathToModule['/app/workbench'] = 'app-workbench.js';
        pathToModule['/app/marketplace'] = 'app-marketplace.js';
        pathToModule['/admin/employees'] = 'admin-employees.js';
        pathToModule['/admin/solutions'] = 'admin-solutions.js';
        pathToModule['/admin/skills'] = 'admin-skills.js';
        pathToModule['/admin/memories'] = 'admin-memories.js';
        pathToModule['/admin/connectors'] = 'admin-connectors.js';
        pathToModule['/admin/billing/usage'] = 'admin-billing.js';
        pathToModule['/admin/billing/recharge'] = 'admin-recharge.js';
        pathToModule['/admin/settings'] = 'admin-settings.js';
        pathToModule['/system/health'] = 'system-health.js';
        pathToModule['/system/templates'] = 'system-templates.js';
        pathToModule['/system/solutions'] = 'system-solutions.js';
        pathToModule['/system/finance'] = 'system-finance.js';
        pathToModule['/system/accounts'] = 'system-accounts.js';

        var moduleScript = pathToModule[currentPath];
        var _appRouteHandler = null;

        // Regex fallback for dynamic app/admin routes
        if (!moduleScript) {
          var _DYNAMIC_ROUTES = [
            { re: /^\/app\/workbench\/?$/, script: 'app-workbench.js', handler: 'appWorkbench' },
            { re: /^\/app\/marketplace\/?$/, script: 'app-marketplace.js', handler: 'appMarketplace' },
            { re: /^\/app\/marketplace\/[^/]+\/?$/, script: 'app-template-detail.js', handler: 'appTemplateDetail' },
            { re: /^\/app\/chat\/[^/]+\/?$/, script: 'app-chat.js', handler: 'appChat' },
            { re: /^\/app\/group\/[^/]+\/?$/, script: 'app-group.js', handler: 'appGroup' },
            { re: /^\/admin\/employees\/[^/]+(?:\/[^/]+)?\/?$/, script: 'admin-employees.js', handler: 'adminEmployees' },
          ];
          for (var _ri = 0; _ri < _DYNAMIC_ROUTES.length; _ri += 1) {
            if (_DYNAMIC_ROUTES[_ri].re.test(currentPath)) {
              moduleScript = _DYNAMIC_ROUTES[_ri].script;
              _appRouteHandler = _DYNAMIC_ROUTES[_ri].handler;
              break;
            }
          }
        }
        if (moduleScript) {
          main.innerHTML = '<p>加载页面...</p>';
          (function () {
            var scriptEl = document.createElement('script');
            scriptEl.src = 'static/aiteam/pages/' + moduleScript;
            scriptEl.onload = function () {
              var handler = null;
              if (_appRouteHandler === 'appWorkbench') {
                handler = aiteam.pages && aiteam.pages.appWorkbench;
              } else if (_appRouteHandler === 'appMarketplace') {
                handler = aiteam.pages && aiteam.pages.appMarketplace;
              } else if (_appRouteHandler === 'appTemplateDetail') {
                handler = aiteam.pages && aiteam.pages.appTemplateDetail;
              } else if (_appRouteHandler === 'appChat') {
                handler = aiteam.pages && aiteam.pages.appChat;
              } else if (_appRouteHandler === 'appGroup') {
                handler = aiteam.pages && aiteam.pages.appGroup;
              } else if (_appRouteHandler === 'adminEmployees') {
                handler = aiteam.pages && aiteam.pages.adminEmployees;
              } else if (currentPath === '/app/org' || currentPath.indexOf('/app/org/') === 0) {
                handler = aiteam.pages && aiteam.pages.appOrg;
              } else if (currentPath === '/app/knowledge' || currentPath.indexOf('/app/knowledge') === 0) {
                handler = aiteam.pages && aiteam.pages.knowledge;
              } else if (currentPath === '/app/office' || currentPath.indexOf('/app/office/') === 0) {
                handler = aiteam.pages && aiteam.pages.office;
              } else if (currentPath === '/admin/employees' || currentPath.indexOf('/admin/employees') === 0) {
                handler = aiteam.pages && aiteam.pages.adminEmployees;
              } else if (currentPath === '/admin/solutions' || currentPath.indexOf('/admin/solutions') === 0) {
                handler = aiteam.pages && aiteam.pages.adminSolutions;
              } else if (currentPath === '/admin/skills' || currentPath.indexOf('/admin/skills') === 0) {
                handler = aiteam.pages && aiteam.pages.adminSkills;
              } else if (currentPath === '/admin/memories' || currentPath.indexOf('/admin/memories') === 0) {
                handler = aiteam.pages && aiteam.pages.adminMemories;
              } else if (currentPath === '/admin/connectors' || currentPath.indexOf('/admin/connectors') === 0) {
                handler = aiteam.pages && aiteam.pages.adminConnectors;
              } else if (currentPath.indexOf('/admin/billing/recharge') === 0) {
                handler = aiteam.pages && aiteam.pages.adminRecharge;
              } else if (currentPath.indexOf('/admin/billing/usage') === 0) {
                handler = aiteam.pages && aiteam.pages.adminBilling;
              } else if (currentPath.indexOf('/admin/settings') === 0) {
                handler = aiteam.pages && aiteam.pages.adminSettings;
              } else if (currentPath.indexOf('/system/health') === 0) {
                handler = aiteam.pages && aiteam.pages.systemHealth;
              } else if (currentPath.indexOf('/system/templates') === 0) {
                handler = aiteam.pages && aiteam.pages.systemTemplates;
              } else if (currentPath.indexOf('/system/solutions') === 0) {
                handler = aiteam.pages && aiteam.pages.systemSolutions;
              } else if (currentPath.indexOf('/system/finance') === 0) {
                handler = aiteam.pages && aiteam.pages.systemFinance;
              } else if (currentPath.indexOf('/system/accounts') === 0) {
                handler = aiteam.pages && aiteam.pages.systemAccounts;
              }
              if (handler && handler.init) {
                handler.init(main);
              } else {
                main.innerHTML = '<p>页面模块加载失败</p>';
              }
            };
            scriptEl.onerror = function () {
              main.innerHTML = '<p>页面脚本加载失败</p>';
            };
            document.head.appendChild(scriptEl);
          })();
          return;
        }

        var oname = (section === 'app') ? '企业前台' : ((section === 'admin') ? '企业后台' : '系统后台');
        main.innerHTML =
          '<div class="aiteam-shell__panel">' +
          '<p class="aiteam-shell__panel-kicker">' + oname + '</p>' +
          '<h2 class="aiteam-shell__panel-title">' + (SECTION_TITLES[section] || SECTION_TITLES.app).title + '</h2>' +
          '<p class="aiteam-shell__panel-body">此页面区域将在后续迭代中接入真实业务视图。</p>' +
          '<div class="aiteam-shell__meta">' +
          '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">当前路径</span><span class="aiteam-shell__meta-value">' + window.location.pathname + '</span></div>' +
          '<div class="aiteam-shell__meta-card"><span class="aiteam-shell__meta-label">页面分区</span><span class="aiteam-shell__meta-value">' + oname + '</span></div>' +
          '</div>' +
          '</div>';
      }
    },
  };
}(window.aiteam));
