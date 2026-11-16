/**
 * 企业端壳组件：基于 page-shell 视图模型，用 Astryx AppShell 渲染。
 *
 * 渲染由 buildShellViewModel 产出的可见导航树；未登录只渲染登录入口（requiresLogin）。
 * 不做跨端聚合（08 §12.3 无中心 BFF）——导航全部指向本端路由。
 */
import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { AppShell as AstryxAppShell } from "@astryxdesign/core/AppShell";
import {
  SideNav,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from "@astryxdesign/core/SideNav";
import { buildShellViewModel } from "@aiteam/shared";
import { managerShellConfig } from "./config";
import { useSession } from "../auth/session";
import { useI18n } from "../i18n/context";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { TopBar } from "./TopBar";
import { useMe } from "./useMe";

export function AppShell(): React.ReactNode {
  const { session, signOut } = useSession();
  const i18n = useI18n();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const me = useMe();
  const [changingPw, setChangingPw] = useState(false);
  const isAdmin = Boolean(me?.roles.some((role) => role === "owner" || role === "enterprise_admin"));
  const vm = buildShellViewModel(managerShellConfig, session, pathname);

  if (vm.requiresLogin) {
    // 未登录：壳退化为仅登录入口，由路由层 <RequireAuth> 把页面切到 /login。
    return <Outlet />;
  }

  const sideNav = (
    <SideNav
      header={<SideNavHeading heading={i18n.t(vm.titleKey)} headingHref="/" />}
      collapsible={{ buttonLabel: "收起企业端导航" }}
    >
      <SideNavSection title="主导航" isHeaderHidden>
        {vm.nav.map((item) => (
          <SideNavItem
            key={item.id}
            label={i18n.t(item.labelKey)}
            href={item.path}
            isSelected={item.id === vm.activeItemId}
          />
        ))}
      </SideNavSection>
    </SideNav>
  );

  return (
    <AstryxAppShell
      variant="elevated"
      contentPadding={4}
      topNav={<TopBar me={me} onSignOut={signOut} onChangePassword={() => setChangingPw(true)} onSetEnterpriseName={isAdmin ? () => navigate("/settings") : undefined} />}
      sideNav={sideNav}
      mobileNav={{ breakpoint: "md" }}
    >
      <Outlet />
      {changingPw && me && <ChangePasswordDialog policy={me.password_policy} onClose={() => setChangingPw(false)} />}
    </AstryxAppShell>
  );
}
