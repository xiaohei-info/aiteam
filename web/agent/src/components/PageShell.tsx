/** 用户端路由壳：保留 page-shell 视图模型，用本端 Astryx shell 渲染。 */
import { useLocation } from "react-router-dom";
import { AppShell as AstryxAppShell } from "@astryxdesign/core/AppShell";
import {
  SideNav,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from "@astryxdesign/core/SideNav";
import { buildShellViewModel } from "@aiteam/shared/page-shell";

import { agentShellConfig } from "../config/nav";
import { useApp } from "../lib/app-context";

export function PageShell({ children }: { children: React.ReactNode }) {
  const { session, i18n } = useApp();
  const { pathname } = useLocation();
  const model = buildShellViewModel(agentShellConfig, session, pathname);
  const contentPadding = pathname === "/chat" || pathname === "/group" ? 0 : 4;
  const sideNav = (
    <SideNav
      header={<SideNavHeading heading={i18n.t(model.titleKey)} headingHref="/" />}
      collapsible={{ buttonLabel: "收起用户端导航" }}
    >
      <SideNavSection title="主导航" isHeaderHidden>
        {model.nav.map((item) => (
          <SideNavItem
            key={item.id}
            label={i18n.t(item.labelKey)}
            href={item.path}
            isSelected={item.id === model.activeItemId}
          />
        ))}
      </SideNavSection>
    </SideNav>
  );

  return (
    <AstryxAppShell
      variant="elevated"
      contentPadding={contentPadding}
      sideNav={sideNav}
      mobileNav={{ breakpoint: "md" }}
    >
      {children}
    </AstryxAppShell>
  );
}
