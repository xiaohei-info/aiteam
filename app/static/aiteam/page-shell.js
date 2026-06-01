window.aiteam = window.aiteam || {};

(function registerPageShell(ns) {
  var SECTION_PAGES = {
    app: [
      { label: '工作台',    href: '/app/workbench',   note: 'Workbench' },
      { label: '对话',      href: '/app/chat',        note: 'Chat' },
      { label: '群聊',      href: '/app/group',       note: 'Group' },
      { label: '办公室',    href: '/app/office',      note: 'Office' },
    ],
    admin: [
      { label: '员工',      href: '/admin/employees',  note: 'Employees' },
      { label: '连接器',    href: '/admin/connectors', note: 'Connectors' },
      { label: '费用',      href: '/admin/billing/usage', note: 'Billing' },
    ],
    system: [
      { label: '企业',      href: '/system/accounts',  note: 'Enterprises' },
      { label: '健康',      href: '/system/health',    note: 'Health' },
    ],
  };

  var SECTION_TITLES = {
    app: { title: '工作台', subtitle: '企业前台' },
    admin: { title: '企业后台', subtitle: '治理与配置' },
    system: { title: '系统后台', subtitle: '平台运营' },
  };

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
      if (!SECTION_PAGES[section]) section = 'app';

      var titlebar = document.querySelector('.app-titlebar');
      if (titlebar) titlebar.style.display = 'none';

      bodyClassManager.add('aiteam-shell-active');

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
        var pages = SECTION_PAGES[section] || SECTION_PAGES.app;
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

      // ── L4-S04: dynamic page loading ──
      var main = document.getElementById('aiteam-main');
      if (main) {
        var pathToModule = {};

        pathToModule['/admin/employees'] = 'admin-employees.js';
        pathToModule['/admin/billing/usage'] = 'admin-billing.js';
        pathToModule['/system/health'] = 'system-health.js';
        pathToModule['/system/finance'] = 'system-health.js';

        var moduleScript = pathToModule[currentPath];
        if (moduleScript) {
          main.innerHTML = '<p>加载页面...</p>';
          (function () {
            var scriptEl = document.createElement('script');
            scriptEl.src = 'static/aiteam/pages/' + moduleScript;
            scriptEl.onload = function () {
              var handler = null;
              if (currentPath === '/admin/employees' || currentPath.indexOf('/admin/employees') === 0) {
                handler = aiteam.pages && aiteam.pages.adminEmployees;
              } else if (currentPath.indexOf('/admin/billing') === 0) {
                handler = aiteam.pages && aiteam.pages.adminBilling;
              } else if (currentPath.indexOf('/system/health') === 0 || currentPath.indexOf('/system/finance') === 0) {
                handler = aiteam.pages && aiteam.pages.systemHealth;
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
