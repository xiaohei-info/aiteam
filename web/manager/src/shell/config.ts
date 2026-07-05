/**
 * Manager 企业端导航与壳配置（page-shell）。
 *
 * 导航严格对齐旧架构 app/ 的企业后台（admin section）菜单入口：
 * 员工 / 方案 / 技能 / 人才市场 / 记忆 / 连接器 / 模型 / 费用 / 充值 / 设置。
 * 「协作编排」菜单已清理：对应后端 collaboration_template 表是死数据，Agent 群聊不读它（AITEAM-374）。
 * 角色门控映射旧架构 permission_service 的 manage_employees / manage_connectors / view_billing。
 */
import { EnterpriseRole } from "@aiteam/shared";
import type { NavItem, PageShellConfig } from "@aiteam/shared";

export const managerShellConfig: PageShellConfig = {
  tier: "manager",
  titleKey: "manager.title",
  nav: [
    // manage_employees 门控
    { id: "members", labelKey: "manager.nav.members", path: "/members", icon: "members", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN] },
    // 无角色门控
    { id: "solutions", labelKey: "manager.nav.solutions", path: "/solutions", icon: "board" },
    // manage_employees 门控
    { id: "skills", labelKey: "manager.nav.skills", path: "/capability", icon: "catalog", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN] },
    // manage_employees 门控
    { id: "marketplace", labelKey: "manager.nav.marketplace", path: "/marketplace", icon: "catalog", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN] },
    // 无角色门控
    { id: "memory", labelKey: "manager.nav.memory", path: "/memory", icon: "dashboard" },
    // manage_connectors 门控
    { id: "connectors", labelKey: "manager.nav.connectors", path: "/connectors", icon: "catalog", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN] },
    // 无角色门控
    { id: "llm", labelKey: "manager.nav.llm", path: "/llm", icon: "key" },
    // view_billing 门控
    { id: "billing", labelKey: "manager.nav.billing", path: "/billing", icon: "board", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.FINANCE_ADMIN] },
    // view_billing 门控
    { id: "recharge", labelKey: "manager.nav.recharge", path: "/recharge", icon: "dashboard", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.FINANCE_ADMIN] },
    // 无角色门控
    { id: "settings", labelKey: "manager.nav.settings", path: "/settings", icon: "dashboard" },
  ],
};

export type { NavItem };
