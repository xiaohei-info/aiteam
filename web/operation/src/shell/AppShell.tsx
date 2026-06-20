/**
 * 运营端壳组件：左侧导航 + 顶栏 + 内容区。
 *
 * 渲染由 buildShellViewModel 产出的可见导航树；未登录只渲染登录入口（requiresLogin）。
 * 不做跨端聚合（08 §12.3 无中心 BFF）——导航全部指向本端路由。
 */
import { NavLink, Outlet } from "react-router-dom";
import { buildShellViewModel } from "@aiteam/shared";
import { operationShellConfig } from "./config";
import { useSession } from "../auth/session";
import { useI18n } from "../i18n/context";

export function AppShell(): React.ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const path = typeof window !== "undefined" ? window.location.pathname : "/";
  const vm = buildShellViewModel(operationShellConfig, session, path);

  if (vm.requiresLogin) {
    // 未登录：壳退化为仅登录入口，由路由层 <RequireAuth> 把页面切到 /login。
    return <Outlet />;
  }

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <div className="app-shell__brand">{i18n.t(vm.titleKey)}</div>
        <nav className="app-shell__nav">
          {vm.nav.map((item) => (
            <NavLink
              key={item.id}
              to={item.path}
              end={item.path === "/"}
              className={({ isActive }) =>
                `app-shell__nav-item${isActive ? " is-active" : ""}`
              }
            >
              {i18n.t(item.labelKey)}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="app-shell__main">
        <Outlet />
      </main>
    </div>
  );
}
