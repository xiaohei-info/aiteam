/**
 * Manager 企业端导航与壳配置（page-shell）。
 *
 * 企业后台菜单入口：成员 / 部门 / 方案 / 技能 / 人才市场 / 专家实例 / 授权 /
 * 记忆 / 知识库 / 连接器 / 费用 / 充值 / 设置。
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
    // 所有已登录角色可查看；写操作由部门页按 owner/enterprise_admin 门控
    { id: "departments", labelKey: "manager.nav.departments", path: "/departments", icon: "board" },
    // 无角色门控
    { id: "solutions", labelKey: "manager.nav.solutions", path: "/solutions", icon: "board" },
    // manage_employees 门控
    { id: "skills", labelKey: "manager.nav.skills", path: "/skill-market", icon: "catalog", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN] },
    // 招募/实例配置/授权构成 Agent 可用专家的完整管理链路；平台模型目录仅作为专家配置内部数据源。
    { id: "marketplace", labelKey: "manager.nav.marketplace", path: "/marketplace", icon: "catalog", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN] },
    { id: "experts", labelKey: "manager.nav.experts", path: "/experts", icon: "members", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN] },
    { id: "grants", labelKey: "manager.nav.grants", path: "/grants", icon: "key", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN] },
    // 无角色门控
    { id: "memory", labelKey: "manager.nav.memory", path: "/memory", icon: "dashboard", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN] },
    { id: "knowledge", labelKey: "manager.nav.knowledge", path: "/knowledge", icon: "catalog" },
    // manage_connectors 门控
    { id: "connectors", labelKey: "manager.nav.connectors", path: "/connectors", icon: "catalog", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN] },
    // 无角色门控
    // view_billing 门控
    { id: "billing", labelKey: "manager.nav.billing", path: "/billing", icon: "board", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.FINANCE_ADMIN] },
    // view_billing 门控
    { id: "recharge", labelKey: "manager.nav.recharge", path: "/recharge", icon: "dashboard", requiredRoles: [EnterpriseRole.OWNER, EnterpriseRole.FINANCE_ADMIN] },
    // 无角色门控
    { id: "settings", labelKey: "manager.nav.settings", path: "/settings", icon: "dashboard" },
  ],
};

export type { NavItem };
