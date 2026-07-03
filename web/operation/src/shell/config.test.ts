/**
 * 运营端壳配置测试（W-O.1）：tier 锁死 operation、导航按平台角色门控。
 * 壳装配逻辑本身在 @aiteam/shared buildShellViewModel（已覆盖），此处只验运营端配置正确。
 */
import { describe, expect, it } from "vitest";
import {
  buildShellViewModel,
  PlatformRole,
  type AuthSession,
} from "@aiteam/shared";
import { operationShellConfig } from "./config";

function session(roles: string[]): AuthSession {
  return {
    principal: {
      id: "u1",
      display_name: "u1",
      status: "active",
      roles,
    },
    claims: {
      user_id: "u1",
      roles,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
  };
}

describe("operation shell config", () => {
  it("tier 锁死 operation", () => {
    expect(operationShellConfig.tier).toBe("operation");
  });

  it("系统管理员可见全部业务导航", () => {
    const vm = buildShellViewModel(
      operationShellConfig,
      session([PlatformRole.SYSTEM_ADMIN]),
      "/enterprises",
    );
    expect(vm.requiresLogin).toBe(false);
    expect(vm.nav.map((n) => n.id)).toEqual([
      "dashboard",
      "enterprises",
      "accounts",
      "experts",
      "industry-solutions",
      "solutions",
      "finance",
      "board",
      "health",
    ]);
    expect(vm.activeItemId).toBe("enterprises");
  });

  it("系统操作员同样可见业务导航", () => {
    const vm = buildShellViewModel(
      operationShellConfig,
      session([PlatformRole.SYSTEM_OPERATOR]),
      "/experts",
    );
    expect(vm.nav.some((n) => n.id === "experts")).toBe(true);
  });

  it("未登录：requiresLogin=true 且导航为空", () => {
    const vm = buildShellViewModel(operationShellConfig, null, "/");
    expect(vm.requiresLogin).toBe(true);
    expect(vm.nav).toEqual([]);
  });

  it("非平台角色（如企业 member）：业务导航被过滤", () => {
    const vm = buildShellViewModel(
      operationShellConfig,
      session(["member"]),
      "/enterprises",
    );
    // 仅 dashboard（无 requiredRoles）可见，enterprises/catalog/board 被过滤。
    expect(vm.nav.map((n) => n.id)).toEqual(["dashboard"]);
  });
});
