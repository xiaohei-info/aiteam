/**
 * AITEAM-224 企业端（Manager）单端 smoke + API contract（最终执行 DAG §5.1 验收第 3 条）。
 *
 * 覆盖：auth / members / grants / capability / solution / governance / api-contract。
 * 前端只调本端 /api/manager/* + /api/auth/*（08 §12.2），不跨端直调、不直绑 Runtime。
 * 非目标：不重复 service 层业务断言、不测 LLM 文本质量、不绕过 Team Panel 直连 Runtime。
 *
 * 验证命令：npx playwright test --project=manager-smoke
 */

import { test, expect } from "@playwright/test";
import { authTest } from "../support/fixtures";
import {
  expectAuthenticatedEnvelope,
  expectListEnvelope,
  expectProtectedEndpointRequiresAuth,
  expectUnknownRouteProblemJson,
} from "../support/api-assertions";
import { apiLogin, defaultCredentials } from "../support/auth";
import { expectShellReady, collectBrowserErrors, expectLoginPageSmoke } from "../support/smoke";

const TIER = "manager" as const;

test.describe("manager auth", () => {
  test("登录页 shell 与表单可见", async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    await expectLoginPageSmoke(page, { tier: TIER, loginText: /企业|Manager|登录/i });
    expect(browserErrors).toEqual([]);
  });

  test("API 登录返回 token envelope（whoami 鉴权链贯通）", async ({ request }) => {
    const result = await apiLogin(request, TIER);
    await expectAuthenticatedEnvelope(request, TIER, result.token);
  });
});

test.describe("manager api-contract", () => {
  test("未知 /api 路径返回 404 problem+json（非 SPA fallback）", async ({ request }) => {
    await expectUnknownRouteProblemJson(request, TIER);
  });

  test("受保护端点缺 token → 401 problem+json", async ({ request }) => {
    await expectProtectedEndpointRequiresAuth(request, TIER);
  });
});

authTest.describe("manager members（受保护只读）", () => {
  authTest("members 列表返回 list envelope", async ({ request, token }) => {
    await expectListEnvelope(request, TIER, "/api/manager/members", token);
  });

  authTest("departments 列表返回 list envelope", async ({ request, token }) => {
    await expectListEnvelope(request, TIER, "/api/manager/departments", token);
  });

  authTest("members 页面 shell 就绪无 console error", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.goto("/members");
    await expectShellReady(authedPage);
    expect(browserErrors).toEqual([]);
  });
});

authTest.describe("manager grants（受保护只读）", () => {
  authTest("grants 列表返回 list envelope", async ({ request, token }) => {
    await expectListEnvelope(request, TIER, "/api/manager/grants", token);
  });

  authTest("grants 页面 shell 就绪无 console error", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.goto("/grants");
    await expectShellReady(authedPage);
    expect(browserErrors).toEqual([]);
  });
});

authTest.describe("manager capability（受保护只读）", () => {
  authTest("skills 目录返回 list envelope", async ({ request, token }) => {
    await expectListEnvelope(request, TIER, "/api/manager/skills", token);
  });

  authTest("connectors 目录返回 list envelope", async ({ request, token }) => {
    await expectListEnvelope(request, TIER, "/api/manager/connectors", token);
  });

  authTest("capability 页面 shell 就绪无 console error", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.goto("/capability");
    await expectShellReady(authedPage);
    expect(browserErrors).toEqual([]);
  });
});

authTest.describe("manager solution（recruit 招募方案，受保护只读）", () => {
  authTest("recruit solutions 列表返回 list envelope", async ({ request, token }) => {
    await expectListEnvelope(request, TIER, "/api/manager/recruit/solutions", token);
  });

  authTest("recruit catalog experts 列表返回 list envelope", async ({ request, token }) => {
    await expectListEnvelope(request, TIER, "/api/manager/recruit/catalog/experts", token);
  });
});

authTest.describe("manager governance（治理汇总，受保护只读）", () => {
  authTest("usage rollup 列表返回 list envelope", async ({ request, token }) => {
    await expectListEnvelope(request, TIER, "/api/manager/usage/rollup/list", token);
  });

  authTest("audits 列表返回 list envelope", async ({ request, token }) => {
    await expectListEnvelope(request, TIER, "/api/manager/audits", token);
  });

  authTest("quota-policies 列表返回 list envelope", async ({ request, token }) => {
    await expectListEnvelope(request, TIER, "/api/manager/quota-policies", token);
  });

  authTest("governance 页面 shell 就绪无 console error", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.goto("/governance");
    await expectShellReady(authedPage);
    expect(browserErrors).toEqual([]);
  });
});
