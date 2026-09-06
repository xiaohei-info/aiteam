/**
 * AITEAM-224 可复用 harness 自检（最终执行 DAG §5.1 验收第 1 条：harness 可复用）。
 *
 * 验证命令：npx playwright test e2e/support/__tests__/
 *
 * 纯逻辑自检（不依赖三端真实栈）：锁住 harness 模块的确定性行为——tier 映射、storageState
 * 形状、凭据默认值、URL/路径常量、fixtures tier 推导。这些是各端 spec 复用的基座，
 * 必须先绿才能保证三端 smoke 不因 harness 自身漂移而误判。
 *
 * 不验业务（非目标）；真实三端栈贯通由 operation/manager/agent smoke spec 覆盖。
 */

import { expect, test } from "@playwright/test";
import {
  type Tier,
  TIER_BASE_URL,
  TIER_API_ORIGIN,
  TOKEN_STORAGE_KEY,
  AGENT_CLAIMS_STORAGE_KEY,
  STORAGE_STATE_DIR,
  storageStatePath,
  defaultCredentials,
  buildStorageState,
} from "../auth";
import { tierFromProject } from "../fixtures";

const TIERS: Tier[] = ["operation", "manager", "agent"];

test.describe("AITEAM-224 harness: auth 常量与映射", () => {
  test("三端 tier 基址/origin/token-key 三处对齐", () => {
    for (const tier of TIERS) {
      if (tier === "manager") {
        // Manager local E2E uses localhost so WebAuthn gets a DNS RP ID;
        // its API remains a separate loopback service origin.
        expect(TIER_BASE_URL[tier]).toMatch(/^http:\/\/localhost:\d+$/);
      } else {
        expect(TIER_BASE_URL[tier]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      }
      expect(TIER_API_ORIGIN[tier]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(TIER_BASE_URL[tier]).not.toBe(TIER_API_ORIGIN[tier]);
      expect(TOKEN_STORAGE_KEY[tier]).toMatch(new RegExp(`^aiteam\\.${tier}\\.(token|agent)`));
    }
  });

  test("operation token key 精确对齐 AppProviders", () => {
    expect(TOKEN_STORAGE_KEY.operation).toBe("aiteam.operation.token");
    expect(TOKEN_STORAGE_KEY.manager).toBe("aiteam.manager.token");
    expect(TOKEN_STORAGE_KEY.agent).toBe("aiteam.agent.token");
    expect(AGENT_CLAIMS_STORAGE_KEY).toBe("aiteam.agent.claims");
  });

  test("storageStatePath 路径落在 .auth 目录", () => {
    for (const tier of TIERS) {
      const p = storageStatePath(tier);
      expect(p).toContain(STORAGE_STATE_DIR);
      expect(p).toBe(`${STORAGE_STATE_DIR}/storageState.${tier}.json`);
    }
  });
});

test.describe("AITEAM-224 harness: 凭据默认值", () => {
  test("operation 默认凭据对齐 server conftest", () => {
    const c = defaultCredentials("operation");
    expect(c.username).toBe("sysadmin");
    expect(c.password).toBeTruthy();
    expect(c.account).toBeUndefined();
    expect(c.tenant_id).toBeUndefined();
  });

  test("manager/agent 默认凭据含 account + tenant_id", () => {
    for (const tier of ["manager", "agent"] as Tier[]) {
      const c = defaultCredentials(tier);
      expect(c.account).toBeTruthy();
      expect(c.password).toBeTruthy();
      expect(c.tenant_id).toBeTruthy();
      expect(c.username).toBeUndefined();
    }
  });

  test("env 覆盖默认凭据", () => {
    const prevUser = process.env.E2E_OPERATION_USERNAME;
    const prevPwd = process.env.E2E_OPERATION_PASSWORD;
    process.env.E2E_OPERATION_USERNAME = "envadmin";
    process.env.E2E_OPERATION_PASSWORD = "env-pwd";
    try {
      const c = defaultCredentials("operation");
      expect(c.username).toBe("envadmin");
      expect(c.password).toBe("env-pwd");
    } finally {
      if (prevUser === undefined) delete process.env.E2E_OPERATION_USERNAME;
      else process.env.E2E_OPERATION_USERNAME = prevUser;
      if (prevPwd === undefined) delete process.env.E2E_OPERATION_PASSWORD;
      else process.env.E2E_OPERATION_PASSWORD = prevPwd;
    }
  });
});

test.describe("AITEAM-224 harness: buildStorageState 形状", () => {
  test("operation/manager storageState 只持久化 token", () => {
    for (const tier of ["operation", "manager"] as Tier[]) {
      const state = buildStorageState(tier, "tok-123");
      expect(state.cookies).toEqual([]);
      expect(state.origins).toHaveLength(1);
      expect(state.origins[0].origin).toBe(TIER_BASE_URL[tier]);
      expect(state.origins[0].localStorage).toEqual([
        { name: TOKEN_STORAGE_KEY[tier], value: "tok-123" },
      ]);
    }
  });

  test("agent storageState 持久化 token + claims", () => {
    const claims = { user_id: "u1", tenant_id: "t1", roles: ["member"], exp: 9999 };
    const state = buildStorageState("agent", "tok-456", claims);
    const ls = state.origins[0].localStorage;
    expect(ls).toHaveLength(2);
    expect(ls.find((e) => e.name === TOKEN_STORAGE_KEY.agent)?.value).toBe("tok-456");
    const claimsEntry = ls.find((e) => e.name === AGENT_CLAIMS_STORAGE_KEY);
    expect(claimsEntry).toBeTruthy();
    expect(JSON.parse(claimsEntry!.value)).toEqual(claims);
  });

  test("agent storageState 无 claims 时只持久化 token", () => {
    const state = buildStorageState("agent", "tok-7");
    expect(state.origins[0].localStorage).toHaveLength(1);
    expect(state.origins[0].localStorage[0].name).toBe(TOKEN_STORAGE_KEY.agent);
  });
});

test.describe("AITEAM-224 harness: fixtures tier 推导", () => {
  test("project 名 → tier 映射", () => {
    expect(tierFromProject("operation-smoke")).toBe("operation");
    expect(tierFromProject("manager-smoke")).toBe("manager");
    expect(tierFromProject("agent-smoke")).toBe("agent");
  });

  test("未知 project 名抛错（防静默漂移）", () => {
    expect(() => tierFromProject("unknown-project")).toThrow(/tier/);
    expect(() => tierFromProject(undefined)).toThrow(/tier/);
  });
});
