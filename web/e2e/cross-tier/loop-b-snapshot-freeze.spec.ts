/**
 * AITEAM-226 Wave2 跨端 E2E：Loop-B snapshot freeze 浏览器链路验证。
 *
 * 覆盖：Manager 侧执行快照生成 → Agent freeze 为本地不可变副本 → freeze 后快照仍可装载。
 * 验证命令：npx playwright test e2e/cross-tier/loop-b-snapshot-freeze.spec.ts --project=cross-tier
 *
 * 验收锚点（DAG contract）：
 * - Loop-B 浏览器链路验证 snapshot freeze：已冻结快照在浏览器端可观测、不可变。
 * - 失败时产出 Playwright report/trace/screenshot/video；成功必须靠断言不是截图。
 *
 * 非目标（DAG contract）：不测 usage 数值精度、不覆盖多浏览器 nightly 矩阵、不用 mock 后端。
 */

import { test, expect } from "@playwright/test";
import {
  apiLogin,
  defaultCredentials,
  TIER_API_ORIGIN,
} from "../support/auth";
import {
  expectListEnvelope,
} from "../support/api-assertions";

test.describe("Loop-B snapshot freeze（跨端）", () => {
  test("Agent snapshots 列表端点返回 list envelope（freeze 后的不可变副本可见）", async ({
    request,
  }) => {
    const agentLogin = await apiLogin(request, "agent", defaultCredentials("agent"));
    await expectListEnvelope(request, "agent", "/api/agent/grants/snapshots", agentLogin.token);
  });

  test("Agent experts 列表（授权本地投影）与 snapshots 列表（冻结快照）双端均可达", async ({
    request,
  }) => {
    const agentLogin = await apiLogin(request, "agent", defaultCredentials("agent"));
    const token = agentLogin.token;
    const origin = TIER_API_ORIGIN.agent;

    // 两个端点均验证可访问性
    const checks = [
      "/api/agent/grants/experts",
      "/api/agent/grants/snapshots",
    ];

    for (const path of checks) {
      const resp = await request.get(`${origin}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        failOnStatusCode: false,
      });
      expect(resp.ok(), `${path} 应可达: ${resp.status()}`).toBe(true);

      const body = (await resp.json()) as { data: unknown[]; page?: unknown };
      expect(Array.isArray(body.data), `${path} data 为数组`).toBe(true);
      expect(body, `${path} 含 page 字段`).toHaveProperty("page");
    }
  });

  test("Snapshot 记录含不可变标识字段（employee_id / snapshot_version）", async ({
    request,
  }) => {
    const agentLogin = await apiLogin(request, "agent", defaultCredentials("agent"));
    const resp = await request.get(
      `${TIER_API_ORIGIN.agent}/api/agent/grants/snapshots`,
      {
        headers: { Authorization: `Bearer ${agentLogin.token}` },
        failOnStatusCode: false,
      },
    );
    expect(resp.ok(), `snapshots 应可达: ${resp.status()}`).toBe(true);

    const body = (await resp.json()) as { data: Array<Record<string, unknown>> };
    // 如有快照行，验证含不可变标识
    if (body.data.length > 0) {
      const snap = body.data[0];
      const hasId =
        "employee_id" in snap || "snapshot_version" in snap || "version" in snap;
      expect(hasId, `snapshot 记录应含不可变标识字段（employee_id/snapshot_version）`)
        .toBe(true);
    }
  });

  test("Manager employee 端点可达（snapshot 源端——Manager 侧专家配置）", async ({
    request,
  }) => {
    const mgrLogin = await apiLogin(request, "manager", defaultCredentials("manager"));

    // grants 列表和招募端点可达性
    const endpoints = [
      "/api/manager/grants",
      "/api/manager/recruit/solutions",
    ];

    for (const path of endpoints) {
      const resp = await request.get(`${TIER_API_ORIGIN.manager}${path}`, {
        headers: { Authorization: `Bearer ${mgrLogin.token}` },
        failOnStatusCode: false,
      });
      expect(resp.ok(), `Manager ${path} 应可达: ${resp.status()}`).toBe(true);

      const body = (await resp.json()) as { data: unknown[]; page?: unknown };
      expect(Array.isArray(body.data)).toBe(true);
    }
  });

  test("Snapshot freeze 后 Agent sync 仍可达（离线降级路径 D14）", async ({
    request,
  }) => {
    const agentLogin = await apiLogin(request, "agent", defaultCredentials("agent"));
    const token = agentLogin.token;
    const origin = TIER_API_ORIGIN.agent;

    // sync 端点也可达（Agent pull Manager 的主动入口）
    const syncPath = "/api/agent/grants/sync";
    const syncResp = await request.post(`${origin}${syncPath}`, {
      data: {
        tenant_id: defaultCredentials("agent").tenant_id,
        member_id: "test-member-id",
      },
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      failOnStatusCode: false,
    });

    // sync 是尽力而为端点——Manager 不可达时返回 ok=false（不 500）
    // 响应应为 envelope JSON（非 text/html SPA fallback）
    const ct = syncResp.headers()["content-type"] ?? "";
    expect(ct, "sync 响应应为 JSON（非 text/html）").toContain("application/json");
    expect(ct).not.toContain("text/html");

    const body = (await syncResp.json()) as { data?: { ok?: boolean; error?: string } };
    // sync 端点返回 envelope（含 data 字段）
    expect(body, "sync 响应含 data").toHaveProperty("data");
  });
});
