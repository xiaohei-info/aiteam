/**
 * 用户端路由壳（08 §12.2 / page-shell）。基于 buildShellViewModel 渲染导航与布局。
 *
 * 复用 shared 的过滤/激活项解析逻辑；本组件只负责把视图模型渲染成 React 布局。
 * 跨端聚合为零（无中心 BFF，08 §12.3）。
 */

import { NavLink } from "react-router-dom";
import { buildShellViewModel } from "@aiteam/shared/page-shell";

import { agentShellConfig } from "../lib/shell-config";
import { useApp } from "../lib/app-context";

export function PageShell({ children }: { children: React.ReactNode }) {
  const { session, i18n } = useApp();
  const model = buildShellViewModel(
    agentShellConfig,
    session,
    typeof window !== "undefined" ? window.location.pathname : "/workspace",
  );

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <div className="app-shell__brand">{i18n.t(model.titleKey)}</div>
        {model.nav.map((item) => (
          <NavLink
            key={item.id}
            to={item.path}
            className={({ isActive }) =>
              `app-shell__nav-item${isActive ? " app-shell__nav-item--active" : ""}`
            }
          >
            {i18n.t(item.labelKey)}
          </NavLink>
        ))}
      </aside>
      <main className="app-shell__main">{children}</main>
    </div>
  );
}
