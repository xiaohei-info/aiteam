/**
 * AITEAM-224 运营端（Operator）单端 smoke + API contract（最终执行 DAG §5.1 验收第 2 条）。
 *
 * 覆盖：auth / enterprise / catalog / board / api-contract。
 * 前端只调本端 /api/operation/* + /api/operation/auth/*（08 §12.2），不跨端直调、不直绑 Runtime。
 * 非目标：不重复 service 层业务断言、不测 LLM 文本质量、不绕过 Team Panel 直连 Runtime。
 *
 * 验证命令：npx playwright test --project=operation-smoke
 */

import { test, expect } from "@playwright/test";
import { authTest } from "../support/fixtures";
import {
  expectAuthenticatedEnvelope,
  expectEnvelope,
  expectProblemJson,
  expectProtectedEndpointRequiresAuth,
  expectUnknownRouteProblemJson,
} from "../support/api-assertions";
import { apiLogin, defaultCredentials, TIER_API_ORIGIN } from "../support/auth";
import { expectShellReady, collectBrowserErrors, expectLoginPageSmoke } from "../support/smoke";

const TIER = "operation" as const;

test.describe("operation auth", () => {
  test("登录页 shell 与表单可见", async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    await expectLoginPageSmoke(page, { tier: TIER, loginText: /运营|Operator|登录/i });
    expect(browserErrors).toEqual([]);
  });

  test("API 登录返回 token envelope（whoami 鉴权链贯通）", async ({ request }) => {
    const result = await apiLogin(request, TIER);
    await expectAuthenticatedEnvelope(request, TIER, result.token);
  });
});

test.describe("operation api-contract", () => {
  test("未知 /api 路径返回 404 problem+json（非 SPA fallback）", async ({ request }) => {
    await expectUnknownRouteProblemJson(request, TIER);
  });

  test("受保护端点缺 token → 401 problem+json", async ({ request }) => {
    await expectProtectedEndpointRequiresAuth(request, TIER);
  });

  test("错误响应不是 text/html SPA fallback", async ({ request }) => {
    // /api/operation/enterprises 是 POST-only：GET → 405 problem+json（验错误模型，非 SPA）。
    await expectProblemJson(request, TIER, "/api/operation/enterprises", { expectedStatus: 405 });
  });
});

authTest.describe("operation enterprise（受保护）", () => {
  authTest("whoami 带 token → 200 envelope（鉴权链贯通）", async ({ authedRequest }) => {
    const response = await authedRequest.get("/api/operation/whoami", { failOnStatusCode: false });
    expect(response.ok(), `whoami failed: ${response.status()}`).toBeTruthy();
    const body = (await response.json()) as { data: unknown };
    expect(body).toHaveProperty("data");
  });

  authTest("enterprises 写端点受 Bearer 鉴权保护（无 token POST → 401 problem+json）", async ({ request }) => {
    // 验 enterprise 写端点受 require_claims 守卫：无 token POST → 401 problem+json（非 SPA fallback）。
    // 不做真实跨端 provisioning（service-token 跨端链路非本卡 smoke 范围）。
    const response = await request.post(`${TIER_API_ORIGIN.operation}/api/operation/enterprises`, {
      data: { enterprise_name: "e2e-smoke-enterprise", owner_phone: "13800000001" },
      failOnStatusCode: false,
    });
    expect(response.status(), "enterprises POST 无 token 应 401").toBe(401);
    expect(response.headers()["content-type"] ?? "").toContain("application/problem+json");
    expect((await response.text()).toLowerCase()).not.toContain("<!doctype html");
  });
});

authTest.describe("operation catalog（受保护只读）", () => {
  authTest("catalog 列表返回 envelope（data 为数组）", async ({ request, token }) => {
    // operation catalog 是 Envelope[list]（无 page 字段，非 ListEnvelope 分页形态）。
    await expectEnvelope(request, TIER, "/api/operation/catalog", token, { dataIsArray: true });
  });

  authTest("catalog 页面 shell 就绪无 console error", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.goto("/catalog");
    await expectShellReady(authedPage);
    expect(browserErrors).toEqual([]);
  });
});

authTest.describe("operation board（受保护只读）", () => {
  authTest("rollups/board 返回 envelope（单对象）", async ({ request, token }) => {
    // operation rollups/board 是 Envelope[CrossEnterpriseBoard]（单对象，非列表）。
    await expectEnvelope(request, TIER, "/api/operation/rollups/board", token);
  });

  authTest("board 页面 shell 就绪无 console error", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.goto("/board");
    await expectShellReady(authedPage);
    expect(browserErrors).toEqual([]);
  });
});
