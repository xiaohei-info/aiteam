/**
 * 企业端壳配置测试（W-M）：tier 锁死 manager、导航按企业角色门控。
 * 壳装配逻辑本身在 @aiteam/shared buildShellViewModel（已覆盖），此处只验企业端配置正确。
 * 红线：只用 EnterpriseRole（owner / enterprise_admin / finance_admin / member），禁旧 admin/manager/viewer。
 *
 * 导航对齐旧架构 app/ 企业后台 admin section 的 11 个入口：
 * 员工 / 方案 / 技能 / 人才市场 / 记忆 / 连接器 / 模型 / 协作编排 / 费用 / 充值 / 设置
 */
import { describe, expect, it } from "vitest";
import {
  buildShellViewModel,
  EnterpriseRole,
  type AuthSession,
} from "@aiteam/shared";
import { managerShellConfig } from "./config";

function session(roles: string[]): AuthSession {
  return {
    principal: {
      id: "u1",
      tenant_id: "t1",
      display_name: "u1",
      status: "active",
      roles,
    },
    claims: {
      user_id: "u1",
      tenant_id: "t1",
      roles,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
  };
}

const ALL_NAV_IDS = [
  "members",
  "solutions",
  "skills",
  "marketplace",
  "memory",
  "connectors",
  "llm",
  "collaboration",
  "billing",
  "recharge",
  "settings",
] as const;

describe("manager shell config", () => {
  it("tier 锁死 manager", () => {
    expect(managerShellConfig.tier).toBe("manager");
  });

  it("导航严格对齐旧架构 admin section（11 项）", () => {
    const navIds = managerShellConfig.nav.map((n) => n.id);
    expect(navIds).toEqual([...ALL_NAV_IDS]);
    expect(navIds).toHaveLength(11);
  });

  it("owner 可见全部 11 项导航", () => {
    const vm = buildShellViewModel(
      managerShellConfig,
      session([EnterpriseRole.OWNER]),
      "/members",
    );
    expect(vm.requiresLogin).toBe(false);
    expect(vm.nav.map((n) => n.id)).toEqual([...ALL_NAV_IDS]);
    expect(vm.activeItemId).toBe("members");
  });

  it("enterprise_admin 可见管理项（费用/充值被 view_billing 过滤）", () => {
    const vm = buildShellViewModel(
      managerShellConfig,
      session([EnterpriseRole.ENTERPRISE_ADMIN]),
      "/members",
    );
    expect(vm.nav.map((n) => n.id)).toEqual([
      "members",
      "solutions",
      "skills",
      "marketplace",
      "memory",
      "connectors",
      "llm",
      "collaboration",
      "settings",
    ]);
  });

  it("finance_admin 只见无角色门控项 + 费用/充值", () => {
    const vm = buildShellViewModel(
      managerShellConfig,
      session([EnterpriseRole.FINANCE_ADMIN]),
      "/billing",
    );
    expect(vm.nav.map((n) => n.id)).toEqual([
      "solutions",
      "memory",
      "llm",
      "billing",
      "recharge",
      "settings",
    ]);
    expect(vm.activeItemId).toBe("billing");
  });

  it("member 只见无角色门控项（员工/技能/人才市场/协作/连接器/费用/充值被过滤）", () => {
    const vm = buildShellViewModel(
      managerShellConfig,
      session([EnterpriseRole.MEMBER]),
      "/solutions",
    );
    expect(vm.nav.map((n) => n.id)).toEqual([
      "solutions",
      "memory",
      "llm",
      "settings",
    ]);
  });

  it("未登录：requiresLogin=true 且导航为空", () => {
    const vm = buildShellViewModel(managerShellConfig, null, "/");
    expect(vm.requiresLogin).toBe(true);
    expect(vm.nav).toEqual([]);
  });

  it("skills 导航指向 capability 页面（技能管理入口）", () => {
    const skillsItem = managerShellConfig.nav.find((n) => n.id === "skills");
    expect(skillsItem?.path).toBe("/capability");
  });

  it("recharge 导航指向 /recharge", () => {
    const rechargeItem = managerShellConfig.nav.find((n) => n.id === "recharge");
    expect(rechargeItem?.path).toBe("/recharge");
  });
});
