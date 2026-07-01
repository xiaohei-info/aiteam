import { EnterpriseRole } from "@aiteam/shared";
import type { NavItem, PageShellConfig } from "@aiteam/shared";

export const managerShellConfig: PageShellConfig = {
  tier: "manager",
  titleKey: "manager.title",
  nav: [
    { id: "dashboard", labelKey: "manager.nav.dashboard", path: "/", icon: "dashboard" },
    { id: "members", labelKey: "manager.nav.members", path: "/members", icon: "members", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN] },
    { id: "experts", labelKey: "manager.nav.experts", path: "/experts", icon: "experts", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN] },
    { id: "solution_apply", labelKey: "manager.nav.solution_apply", path: "/solution-apply", icon: "board" },
    { id: "grants", labelKey: "manager.nav.grants", path: "/grants", icon: "grants", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN] },
    { id: "governance", labelKey: "manager.nav.governance", path: "/governance", icon: "governance", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN, EnterpriseRole.FINANCE_ADMIN] },
    { id: "providers", labelKey: "manager.nav.providers", path: "/providers", icon: "key", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN] },
    { id: "knowledge", labelKey: "manager.nav.knowledge", path: "/knowledge", icon: "catalog" },
    { id: "capability", labelKey: "manager.nav.capability", path: "/capability", icon: "catalog" },
    { id: "billing", labelKey: "manager.nav.billing", path: "/billing", icon: "board", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN, EnterpriseRole.FINANCE_ADMIN] },
    { id: "llm", labelKey: "manager.nav.llm", path: "/llm", icon: "key", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN] },
    { id: "memory", labelKey: "manager.nav.memory", path: "/memory", icon: "dashboard" },
    { id: "connectors", labelKey: "manager.nav.connectors", path: "/connectors", icon: "catalog" },
    { id: "org", labelKey: "manager.nav.org", path: "/org", icon: "enterprise" },
    { id: "collaboration", labelKey: "manager.nav.collaboration", path: "/collaboration", icon: "dashboard" },
    { id: "audit", labelKey: "manager.nav.audit", path: "/audit", icon: "dashboard" },
    { id: "settings", labelKey: "manager.nav.settings", path: "/settings", icon: "dashboard", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN] },
  ],
};

export type { NavItem };
