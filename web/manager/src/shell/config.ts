/**
 * 企业端导航与壳配置（08 §12.2 page-shell）。
 *
 * 壳视图模型由 @aiteam/shared 的 buildShellViewModel 装配（角色过滤 + 激活项解析），
 * 各端只声明导航树，不复制壳逻辑。企业端导航按企业角色门控：
 *   - 成员账号 / 招募专家 / 成员级授权：管理权（owner / enterprise_admin）。
 *   - 企业治理（计量·审计汇总）：管理权 + 财务管理员（owner / enterprise_admin / finance_admin）。
 *   - 企业概览（dashboard）：登录即可见（无 requiredRoles），member 也能进入。
 * 红线：只用 EnterpriseRole（禁旧 admin/manager/viewer）。
 */
import { EnterpriseRole } from "@aiteam/shared";
import type { NavItem, PageShellConfig } from "@aiteam/shared";

export const managerShellConfig: PageShellConfig = {
  tier: "manager",
  titleKey: "manager.title",
  nav: [
    {
      id: "dashboard",
      labelKey: "manager.nav.dashboard",
      path: "/",
      icon: "dashboard",
    },
    {
      id: "members",
      labelKey: "manager.nav.members",
      path: "/members",
      icon: "members",
      requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN],
    },
    {
      id: "experts",
      labelKey: "manager.nav.experts",
      path: "/experts",
      icon: "experts",
      requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN],
    },
    {
      id: "grants",
      labelKey: "manager.nav.grants",
      path: "/grants",
      icon: "grants",
      requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN],
    },
    {
      id: "governance",
      labelKey: "manager.nav.governance",
      path: "/governance",
      icon: "governance",
      requiredRoles: [
        EnterpriseRole.OWNER,
        EnterpriseRole.ENTERPRISE_ADMIN,
        EnterpriseRole.FINANCE_ADMIN,
      ],
    },
    {
      id: "providers",
      labelKey: "manager.nav.providers",
      path: "/providers",
      icon: "key",
      requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN],
    },
  ],
};

export type { NavItem };
