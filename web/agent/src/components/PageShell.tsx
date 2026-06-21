/** 用户端路由壳：基于 page-shell 视图模型，用 shared AppShell（黑金）渲染。 */
import { Link, useLocation } from "react-router-dom";
import { buildShellViewModel } from "@aiteam/shared/page-shell";
import { AppShell, type AppShellNavItem } from "@aiteam/shared/ui";

import { agentShellConfig } from "../config/nav";
import { useApp } from "../lib/app-context";

export function PageShell({ children }: { children: React.ReactNode }) {
  const { session, i18n } = useApp();
  const { pathname } = useLocation();
  const model = buildShellViewModel(agentShellConfig, session, pathname);
  const nav: AppShellNavItem[] = model.nav.map((item) => ({
    id: item.id,
    label: i18n.t(item.labelKey),
    path: item.path,
    active: item.id === model.activeItemId,
  }));

  return (
    <AppShell
      brand={i18n.t(model.titleKey)}
      nav={nav}
      renderLink={(item, className) => (
        <Link to={item.path} className={className}>
          {item.label}
        </Link>
      )}
    >
      {children}
    </AppShell>
  );
}
