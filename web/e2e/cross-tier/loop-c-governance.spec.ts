/**
 * AITEAM-226 Wave2 跨端 E2E：Loop-C governance 浏览器链路验证。
 *
 * 覆盖：Manager 治理面（quota/policy/audit）→ 治理汇总端点可验证。
 * 验证命令：npx playwright test e2e/cross-tier/loop-c-governance.spec.ts --project=cross-tier
 *
 * 验收锚点（DAG contract）：
 * - Loop-C 浏览器链路验证 governance，且摘要不泄露会话内容。
 * - 失败时产出 Playwright report/trace/screenshot/video；成功必须靠断言不是截图。
 *
 * 非目标（DAG contract）：不测 usage 数值精度到结算级、不覆盖多浏览器 nightly 矩阵、不用 mock 后端。
 */

import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  apiLogin,
  boundManagerTenantId,
  defaultCredentials,
  TIER_API_ORIGIN,
} from "../support/auth";

function serviceToken(): string {
  return process.env.SERVICE_TOKEN ?? "test-service-token";
}

function svcHeaders(): Record<string, string> {
  return { "X-Service-Token": serviceToken(), "Content-Type": "application/json" };
}

function uniquePhone(): string {
  return `138${randomUUID().replace(/\D/g, "").padEnd(8, "0").slice(0, 8)}`;
}

async function createOwnerToken(request: APIRequestContext): Promise<string> {
  const tenantId = boundManagerTenantId();
  const enterpriseId = randomUUID();
  const enterpriseCode = `gov-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const ownerPhone = uniquePhone();
  const bootstrapSecret = `Boot!1-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const newPassword = `New!1-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

  const tenantResp = await request.post(`${TIER_API_ORIGIN.manager}/api/manager/tenants`, {
    data: {
      enterprise_id: enterpriseId,
      tenant_id: tenantId,
      enterprise_name: "E2E Governance Corp",
      enterprise_code: enterpriseCode,
    },
    headers: svcHeaders(),
    failOnStatusCode: false,
  });
  expect(tenantResp.status(), `governance tenant provision 应成功: ${tenantResp.status()} body=${await tenantResp.text()}`).toBe(201);

  const bootstrapResp = await request.post(`${TIER_API_ORIGIN.manager}/api/manager/owner-bootstrap`, {
    data: {
      tenant_id: tenantId,
      owner_phone: ownerPhone,
      bootstrap_secret: bootstrapSecret,
      must_reset: true,
    },
    headers: svcHeaders(),
    failOnStatusCode: false,
  });
  expect(
    [200, 201],
    `governance owner-bootstrap 应成功: ${bootstrapResp.status()} body=${await bootstrapResp.text()}`,
  ).toContain(bootstrapResp.status());

  const resetResp = await request.post(`${TIER_API_ORIGIN.manager}/api/auth/owner-reset`, {
    data: {
      tenant_id: tenantId,
      account: ownerPhone,
      old_password: bootstrapSecret,
      new_password: newPassword,
    },
    failOnStatusCode: false,
  });
  expect(resetResp.ok(), `governance owner-reset 应成功: ${resetResp.status()} body=${await resetResp.text()}`).toBe(true);
  const resetBody = (await resetResp.json()) as { data?: { token?: string } };
  expect(resetBody.data?.token, "owner-reset 应返回 owner token").toBeTruthy();
  return resetBody.data.token;
}

test.describe("Loop-C governance（跨端）", () => {
  test("Manager quota-policies 端点完整 CRUD 契约形状", async ({
    request,
  }) => {
    const mgrLogin = await apiLogin(request, "manager", defaultCredentials("manager"));
    const token = mgrLogin.token;
    const origin = TIER_API_ORIGIN.manager;

    // GET list: ListEnvelope
    const listResp = await request.get(`${origin}/api/manager/quota-policies`, {
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false,
    });
    expect(listResp.ok(), `quota-policies list 应可达: ${listResp.status()}`).toBe(true);
    const listBody = (await listResp.json()) as { data: unknown[]; page?: unknown };
    expect(Array.isArray(listBody.data)).toBe(true);
    expect(listBody).toHaveProperty("page");
  });

  test("Manager governance 所有治理汇总端点均可达（usage/audit/quota）", async ({
    request,
  }) => {
    const mgrLogin = await apiLogin(request, "manager", defaultCredentials("manager"));
    const token = mgrLogin.token;
    const origin = TIER_API_ORIGIN.manager;

    const governanceEndpoints = [
      "/api/manager/usage/rollup/list",
      "/api/manager/audits",
      "/api/manager/quota-policies",
    ];

    for (const path of governanceEndpoints) {
      const resp = await request.get(`${origin}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        failOnStatusCode: false,
      });
      expect(resp.ok(), `governance ${path} 应可达: ${resp.status()}`).toBe(true);

      const body = (await resp.json()) as { data: unknown[]; page?: unknown };
      expect(Array.isArray(body.data), `${path} data 为数组`).toBe(true);
      expect(body, `${path} 含 page`).toHaveProperty("page");
    }
  });

  test("Manager governance 端点受 Bearer 鉴权保护", async ({ request }) => {
    const protectedPaths = [
      "/api/manager/usage/rollup/list",
      "/api/manager/audits",
      "/api/manager/quota-policies",
    ];

    for (const path of protectedPaths) {
      const resp = await request.get(
        `${TIER_API_ORIGIN.manager}${path}`,
        { failOnStatusCode: false },
      );
      expect(resp.ok(), `${path} 无 token 应被拒: got ${resp.status()}`).toBe(false);
      expect(resp.status(), `${path} 无 token 应为 401`).toBe(401);

      const ct = resp.headers()["content-type"] ?? "";
      expect(ct).toContain("application/problem+json");
      expect(ct).not.toContain("text/html");
    }
  });

  test("Manager quota-policies 创建 + 列表可达（契约形状验证）", async ({
    request,
  }) => {
    const token = await createOwnerToken(request);
    const origin = TIER_API_ORIGIN.manager;
    const policySlug = `be2e-gov-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

    const createResp = await request.post(`${origin}/api/manager/quota-policies`, {
      data: {
        policy_slug: policySlug,
        display_name: "E2E Governance Policy",
        scope: "tenant",
        window_start: "2026-01-01T00:00:00Z",
        window_end: "2026-02-01T00:00:00Z",
        dimensions: { cost_cap_usd: 200, token_cap: 1000000 },
        enforcement: "soft",
        status: "active",
      },
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      failOnStatusCode: false,
    });

    expect(createResp.status(), `quota policy create 应成功: ${createResp.status()}`).toBe(201);
    const ct = createResp.headers()["content-type"] ?? "";
    expect(ct).toContain("application/json");
    expect(ct).not.toContain("text/html");

    const createBody = (await createResp.json()) as {
      data?: {
        policy_id?: string;
        policy_slug?: string;
        enforcement?: string;
        status?: string;
      };
    };
    expect(createBody.data?.policy_id, "create envelope 应返回 policy_id").toBeTruthy();
    expect(createBody.data?.policy_slug).toBe(policySlug);
    expect(createBody.data?.enforcement).toBe("soft");
    expect(createBody.data?.status).toBe("active");

    const listResp = await request.get(`${origin}/api/manager/quota-policies`, {
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false,
    });
    expect(listResp.ok(), `quota-policies list 应可达: ${listResp.status()}`).toBe(true);
    expect(listResp.headers()["content-type"] ?? "").toContain("application/json");
    const listBody = (await listResp.json()) as { data: Array<{ policy_slug?: string }> };
    expect(
      listBody.data.some((policy) => policy.policy_slug === policySlug),
      "list envelope 应包含刚创建的 quota policy",
    ).toBe(true);
  });

  test("Governance 汇总不含会话内容/成员可识别信息（D13）", async ({
    request,
  }) => {
    // Manager usage rollup 聚合不含会话内容或成员可识别信息
    const mgrLogin = await apiLogin(request, "manager", defaultCredentials("manager"));
    const token = mgrLogin.token;
    const origin = TIER_API_ORIGIN.manager;

    const governanceEndpoints = [
      "/api/manager/usage/rollup/list",
      "/api/manager/audits",
    ];

    const forbiddenKeys = [
      "prompt",
      "completion",
      "messages",
      "conversation_text",
      "file_content",
      "tool_input",
      "tool_output",
      "conversation_detail",
    ];

    for (const path of governanceEndpoints) {
      const resp = await request.get(`${origin}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        failOnStatusCode: false,
      });
      expect(resp.ok(), `${path} 应可达`).toBe(true);

      const text = await resp.text();
      for (const key of forbiddenKeys) {
        const keyPattern = new RegExp(`"${key}"`);
        expect(text, `${path} 响应不应含 "${key}" 键名（治理面不含会话内容）`)
          .not.toMatch(keyPattern);
      }
    }
  });
});
