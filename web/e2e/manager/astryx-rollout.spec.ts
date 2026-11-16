import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { authTest, expect } from "../support/fixtures";
import {
  collectBrowserErrors,
  expectKeyboardFocusVisible,
} from "../support/smoke";

const governanceResponses = {
  usage: {
    data: [{
      rollup_id: "rollup-001",
      summary_id: "summary-001",
      employee_id: "employee-001",
      window_start: "2026-07-01T00:00:00Z",
      window_end: "2026-07-02T00:00:00Z",
      run_count: 12,
      token_total: 48000,
      cost_total: "25.50",
      error_count: 1,
      duration_seconds_total: 720,
    }],
    page: { next_cursor: null, has_more: false },
  },
  audits: {
    data: [{
      event_id: "audit-001",
      summary_id: "summary-001",
      actor: "owner-001",
      action: "quota_evaluated",
      resource_type: "quota_policy",
      resource_id: "quota-001",
      occurred_at: "2026-07-11T08:30:00Z",
    }],
    page: { next_cursor: null, has_more: false },
  },
  quotas: {
    data: [{
      policy_id: "quota-001",
      policy_slug: "monthly-budget",
      display_name: "月度预算",
      scope: "tenant",
      target_ref: null,
      window_start: "2026-07-01T00:00:00Z",
      window_end: "2026-08-01T00:00:00Z",
      dimensions: { cost_cap_usd: 1000, run_cap: 200 },
      enforcement: "soft",
      status: "active",
      version: 1,
    }],
    page: { next_cursor: null, has_more: false },
  },
};

async function mockGovernance(page: Page): Promise<void> {
  // 顶栏的账号菜单读 /me；真实后端每次的脱敏账号不同，截图会随之变化，这里固定返回。
  await page.route("**/api/manager/me", (route) => route.fulfill({ json: { data: {
    enterprise_name: "示例企业",
    enterprise_code: "demo",
    account_masked: "138****0000",
    roles: ["owner"],
    has_password: true,
    password_policy: { min_length: 8, require_upper: false, require_lower: false, require_digit: true, require_symbol: false, max_age_days: 0 },
  } } }));
  await page.route("**/api/manager/usage/rollup/list**", (route) =>
    route.fulfill({ json: governanceResponses.usage }),
  );
  await page.route("**/api/manager/audits**", (route) =>
    route.fulfill({ json: governanceResponses.audits }),
  );
  await page.route("**/api/manager/quota-policies**", (route) =>
    route.fulfill({ json: governanceResponses.quotas }),
  );
  await page.route("**/api/manager/employees**", (route) => route.fulfill({ json: {
    data: [{ employee_id: "employee-001", display_name: "销售专家" }],
    page: { next_cursor: null, has_more: false },
  } }));
  await page.route("**/api/manager/members**", (route) => route.fulfill({ json: {
    data: [{ id: "owner-001", display_name: "企业负责人" }],
    page: { next_cursor: null, has_more: false },
  } }));
}

async function expectCriticalAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((item) => item.impact === "critical" || item.impact === "serious"),
  ).toEqual([]);
}

authTest.describe("Manager Astryx rollout", () => {
  authTest("登录页保留可访问标题和登录表单", async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    await page.goto("/login");

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("login-form")).toBeVisible();
    await expectCriticalAxeClean(page);
    await expectKeyboardFocusVisible(page);
    expect(browserErrors).toEqual([]);
  });

  authTest("Members、Experts、Governance、Audit 均有标题与主地标", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    const gates = [
      { path: "/members", heading: "成员账号" },
      { path: "/experts", heading: "已招募专家实例" },
      { path: "/governance", heading: "企业治理" },
      { path: "/audit", heading: "审计事件" },
    ];

    for (const gate of gates) {
      if (gate.path === "/governance") await mockGovernance(authedPage);
      await authedPage.goto(gate.path);
      await expect(authedPage.getByRole("heading", { level: 1, name: gate.heading })).toBeVisible();
      await expect(authedPage.getByRole("main")).toBeVisible();
      await expectCriticalAxeClean(authedPage);
      await expectKeyboardFocusVisible(authedPage);
    }

    expect(browserErrors).toEqual([]);
  });

  authTest("治理页在 light 与 dark 模式通过截图、语义和浏览器错误门禁", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await mockGovernance(authedPage);
    await authedPage.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await authedPage.goto("/governance");

    await expect(authedPage.getByRole("table", { name: "计量汇总" })).toBeVisible();
    // 顶栏账号菜单在 /me 返回后才显示脱敏账号；等到默认文案消失再截图，避免截到加载中状态。
    await expect(authedPage.getByRole("button", { name: "账号", exact: true })).toHaveCount(0);
    await expect(authedPage).toHaveScreenshot("manager-rollout-light.png", { fullPage: true });
    await expectCriticalAxeClean(authedPage);
    await expectKeyboardFocusVisible(authedPage);

    await authedPage.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await expect(authedPage).toHaveScreenshot("manager-rollout-dark.png", { fullPage: true });
    expect(browserErrors).toEqual([]);
  });
});
