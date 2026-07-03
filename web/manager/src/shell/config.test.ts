/**
 * 企业端壳配置测试（W-M）：tier 锁死 manager、导航按企业角色门控。
 * 壳装配逻辑本身在 @aiteam/shared buildShellViewModel（已覆盖），此处只验企业端配置正确。
 * 红线：只用 EnterpriseRole（owner / enterprise_admin / finance_admin / member），禁旧 admin/manager/viewer。
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

describe("manager shell config", () => {
  it("tier 锁死 manager", () => {
    expect(managerShellConfig.tier).toBe("manager");
  });

  it("owner 可见全部业务导航", () => {
    const vm = buildShellViewModel(
      managerShellConfig,
      session([EnterpriseRole.OWNER]),
      "/members",
    );
    expect(vm.requiresLogin).toBe(false);
    expect(vm.nav.map((n) => n.id)).toEqual([
      "dashboard",
      "members",
      "marketplace",
      "solutions",
      "experts",
      "solution_apply",
      "grants",
      "governance",
      "providers",
      "knowledge",
      "capability",
      "billing",
      "llm",
      "memory",
      "connectors",
      "org",
      "collaboration",
      "audit",
      "settings",
    ]);
    expect(vm.activeItemId).toBe("members");
  });

  it("enterprise_admin 可见成员/专家/授权/治理", () => {
    const vm = buildShellViewModel(
      managerShellConfig,
      session([EnterpriseRole.ENTERPRISE_ADMIN]),
      "/experts",
    );
    expect(vm.nav.map((n) => n.id)).toEqual([
      "dashboard",
      "members",
      "marketplace",
      "solutions",
      "experts",
      "solution_apply",
      "grants",
      "governance",
      "providers",
      "knowledge",
      "capability",
      "billing",
      "llm",
      "memory",
      "connectors",
      "org",
      "collaboration",
      "audit",
      "settings",
    ]);
    expect(vm.activeItemId).toBe("experts");
  });

  it("finance_admin 只见概览与企业治理（成员/专家/授权被过滤）", () => {
    const vm = buildShellViewModel(
      managerShellConfig,
      session([EnterpriseRole.FINANCE_ADMIN]),
      "/governance",
    );
    expect(vm.nav.map((n) => n.id)).toEqual([
      "dashboard",
      "solution_apply",
      "governance",
      "knowledge",
      "capability",
      "billing",
      "memory",
      "connectors",
      "org",
      "collaboration",
      "audit",
    ]);
    expect(vm.activeItemId).toBe("governance");
  });

  it("member 只见概览（全部管理/治理导航被过滤）", () => {
    const vm = buildShellViewModel(
      managerShellConfig,
      session([EnterpriseRole.MEMBER]),
      "/members",
    );
    expect(vm.nav.map((n) => n.id)).toEqual([
      "dashboard",
      "solution_apply",
      "knowledge",
      "capability",
      "memory",
      "connectors",
      "org",
      "collaboration",
      "audit",
    ]);
  });

  it("未登录：requiresLogin=true 且导航为空", () => {
    const vm = buildShellViewModel(managerShellConfig, null, "/");
    expect(vm.requiresLogin).toBe(true);
    expect(vm.nav).toEqual([]);
  });
});
