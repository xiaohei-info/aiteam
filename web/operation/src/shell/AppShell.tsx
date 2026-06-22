/**
 * 运营端壳组件：基于 page-shell 视图模型，用 shared AppShell（黑金玻璃）渲染。
 *
 * 渲染由 buildShellViewModel 产出的可见导航树；未登录只渲染登录入口（requiresLogin）。
 * 不做跨端聚合（08 §12.3 无中心 BFF）——导航全部指向本端路由。
 */
import { Link, Outlet, useLocation } from "react-router-dom";
import { buildShellViewModel } from "@aiteam/shared";
import { AppShell as SharedAppShell, type AppShellNavItem } from "@aiteam/shared/ui";
import { operationShellConfig } from "./config";
import { useSession } from "../auth/session";
import { useI18n } from "../i18n/context";

export function AppShell(): React.ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const { pathname } = useLocation();
  const vm = buildShellViewModel(operationShellConfig, session, pathname);

  if (vm.requiresLogin) {
    // 未登录：壳退化为仅登录入口，由路由层 <RequireAuth> 把页面切到 /login。
    return <Outlet />;
  }

  const nav: AppShellNavItem[] = vm.nav.map((item) => ({
    id: item.id,
    label: i18n.t(item.labelKey),
    path: item.path,
    active: item.id === vm.activeItemId,
  }));

  return (
    <SharedAppShell
      brand={i18n.t(vm.titleKey)}
      nav={nav}
      renderLink={(item, className) => (
        <Link to={item.path} className={className}>
          {item.label}
        </Link>
      )}
    >
      <Outlet />
    </SharedAppShell>
  );
}
