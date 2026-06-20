/**
 * 运营端导航与壳配置（08 §12.2 page-shell）。
 *
 * 壳视图模型由 @aiteam/shared 的 buildShellViewModel 装配（角色过滤 + 激活项解析），
 * 各端只声明导航树，不复制壳逻辑。运营端导航按平台角色（system_admin / system_operator）门控。
 */
import { PlatformRole } from "@aiteam/shared";
import type { NavItem, PageShellConfig } from "@aiteam/shared";

export const operationShellConfig: PageShellConfig = {
  tier: "operation",
  titleKey: "operation.title",
  nav: [
    {
      id: "dashboard",
      labelKey: "operation.nav.dashboard",
      path: "/",
      icon: "dashboard",
    },
    {
      id: "enterprises",
      labelKey: "operation.nav.enterprises",
      path: "/enterprises",
      icon: "enterprise",
      requiredRoles: [PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR],
    },
    {
      id: "catalog",
      labelKey: "operation.nav.catalog",
      path: "/catalog",
      icon: "catalog",
      requiredRoles: [PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR],
    },
    {
      id: "board",
      labelKey: "operation.nav.board",
      path: "/board",
      icon: "board",
      requiredRoles: [PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR],
    },
  ],
};

export type { NavItem };
