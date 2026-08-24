/**
 * 运营端导航与壳配置（08 §12.2 page-shell）。
 */
import { PlatformRole } from "@aiteam/shared";
import type { NavItem, PageShellConfig } from "@aiteam/shared";

export const operationShellConfig: PageShellConfig = {
  tier: "operation",
  titleKey: "operation.title",
  nav: [
    { id: "dashboard", labelKey: "operation.nav.dashboard", path: "/", icon: "dashboard" },
    { id: "enterprises", labelKey: "operation.nav.enterprises", path: "/enterprises", icon: "enterprise", requiredRoles: [PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR] },
    { id: "accounts", labelKey: "operation.nav.accounts", path: "/accounts", icon: "enterprise", requiredRoles: [PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR] },
    { id: "experts", labelKey: "operation.nav.experts", path: "/experts", icon: "catalog", requiredRoles: [PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR] },
    { id: "skill-market", labelKey: "operation.nav.skillMarket", path: "/skill-market", icon: "catalog", requiredRoles: [PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR] },
    { id: "providers", labelKey: "operation.nav.providers", path: "/providers", icon: "catalog", requiredRoles: [PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR] },
    { id: "industry-solutions", labelKey: "operation.nav.industrySolutions", path: "/industry-solutions", icon: "catalog", requiredRoles: [PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR] },
    { id: "solutions", labelKey: "operation.nav.solutions", path: "/solutions", icon: "catalog", requiredRoles: [PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR] },
    { id: "finance", labelKey: "operation.nav.finance", path: "/finance", icon: "board", requiredRoles: [PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR] },
    { id: "board", labelKey: "operation.nav.board", path: "/board", icon: "board", requiredRoles: [PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR] },
    { id: "health", labelKey: "operation.nav.health", path: "/health", icon: "dashboard", requiredRoles: [PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR] },
  ],
};

export type { NavItem };
