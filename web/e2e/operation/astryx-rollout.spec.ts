import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { authTest, expect } from "../support/fixtures";
import { collectBrowserErrors, expectKeyboardFocusVisible } from "../support/smoke";

const catalogItem = {
  catalog_type: "expert_template",
  template_id: "expert-e2e",
  display_name: "E2E 专家",
  status: "draft",
  visible_scope: { public: true },
  version: "1.0.0",
  system_prompt: "你是 E2E 专家",
  default_model: "gpt-5",
};

async function mockOperationReadModels(page: Page): Promise<void> {
  await page.route("**/api/operation/providers", (route) => route.fulfill({ json: {
    data: [],
    page: { next_cursor: null, has_more: false },
  } }));
  await page.route("**/api/operation/rollups/board", (route) => route.fulfill({ json: {
    data: {
      enterprise_count: 3,
      run_count: 120,
      token_total: 64000,
      cost_total: "88.50",
      error_count: 2,
      duration_seconds_total: 900,
      enterprises: [],
    },
  } }));
  await page.route("**/api/operation/admin/enterprises**", (route) => route.fulfill({ json: {
    data: [{
      org_id: "org-e2e",
      enterprise_name: "E2E 企业",
      contact_name: "测试负责人",
      contact_phone: "13800000000",
      registered_at: "2026-07-11T00:00:00Z",
      total_recharged: "1000.00",
      token_consumed: 1000000,
      status: "active",
      operation_status: "active",
      monthly_active: true,
    }],
    page: { next_cursor: null, has_more: false },
  } }));
  await page.route("**/api/operation/admin/stats", (route) => route.fulfill({ json: {
    data: {
      total_enterprises: 1,
      active_enterprises: 1,
      banned_enterprises: 0,
      new_this_month: 1,
      monthly_active: 1,
      total_recharged: "1000.00",
    },
  } }));
  await page.route("**/api/operation/catalog?**", (route) => route.fulfill({ json: {
    data: [catalogItem],
    page: { next_cursor: null, has_more: false },
  } }));
  await page.route("**/api/operation/catalog/expert_template/expert-e2e", (route) => route.fulfill({ json: { data: catalogItem } }));
  await page.route("**/api/operation/admin/finance/overview?**", (route) => route.fulfill({ json: {
    data: {
      period: "month",
      total_recharged: "1000.00",
      total_tokens_billed: 1000000000,
      total_api_cost: "750.00",
      gross_profit: "250.00",
      profit_margin: 25,
      active_orgs: 1,
      monthly_trend: [],
      top5_consumers: [{ name: "E2E 企业", amount: "750.00" }],
    },
  } }));
  await page.route("**/api/operation/admin/finance/reports?**", (route) => route.fulfill({ json: {
    data: { recharge_details: [], consumption_details: [], profit_details: [] },
  } }));
  await page.route("**/api/operation/admin/solutions/stats", (route) => route.fulfill({ json: {
    data: [{ solution_id: "solution-e2e", name: "E2E 方案", apply_count: 2, active_enterprises: 1 }],
    page: { next_cursor: null, has_more: false },
  } }));
  await page.route("**/api/operation/admin/health", (route) => route.fulfill({ json: {
    data: { status: "healthy", timestamp: "2026-07-11T00:00:00Z", services: { operation: "up", manager: "up" } },
  } }));
}

async function expectCriticalAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((item) => item.impact === "critical" || item.impact === "serious")).toEqual([]);
}

authTest.describe("Operation Astryx rollout", () => {
  authTest("登录页保留可访问标题和表单", async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1, name: "AI Team 运营端" })).toBeVisible();
    await expect(page.getByRole("form", { name: "运营端登录" })).toBeVisible();
    await expectCriticalAxeClean(page);
    await expectKeyboardFocusVisible(page);
    expect(browserErrors).toEqual([]);
  });

  authTest("核心运营页面均有标题、主地标和可见键盘焦点", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await mockOperationReadModels(authedPage);
    const routes = [
      { path: "/enterprises", heading: "企业开通" },
      { path: "/accounts", heading: "企业账号管理" },
      { path: "/experts", heading: "专家" },
      { path: "/industry-solutions", heading: "行业解决方案" },
      { path: "/finance", heading: "财务管理" },
      { path: "/board", heading: "跨企业治理看板" },
      { path: "/health", heading: "系统健康" },
    ];

    for (const route of routes) {
      await authedPage.goto(route.path);
      await expect(authedPage.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
      await expect(authedPage.getByRole("main")).toBeVisible();
      await expectCriticalAxeClean(authedPage);
      await expectKeyboardFocusVisible(authedPage);
    }
    expect(browserErrors).toEqual([]);
  });

  authTest("隐藏目录模板必须经过破坏性确认", async ({ authedPage }) => {
    await mockOperationReadModels(authedPage);
    await authedPage.goto("/experts");
    await authedPage.getByRole("button", { name: "隐藏" }).click();
    await expect(authedPage.getByRole("alertdialog", { name: "隐藏模板" })).toBeVisible();
    await expect(authedPage.getByRole("button", { name: "确认隐藏" })).toBeVisible();
  });

  authTest("语义状态和破坏性操作按钮的文字与底色保持对比度", async ({ authedPage }) => {
    await mockOperationReadModels(authedPage);
    await authedPage.emulateMedia({ colorScheme: "light" });
    await authedPage.goto("/experts");
    const items = authedPage.locator(".astryx-badge.success, .astryx-button.destructive");
    await expect(items.first()).toBeVisible();
    const contrast = await items.evaluateAll((elements) => elements.map((element) => {
      const styles = getComputedStyle(element);
      return { text: element.textContent?.trim(), color: styles.color, background: styles.backgroundColor };
    }));
    expect(contrast.every((item) => item.text && item.color !== item.background)).toBe(true);
  });

  authTest("仪表盘与目录详情通过 light/dark 截图和浏览器错误门禁", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await mockOperationReadModels(authedPage);

    await authedPage.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await authedPage.goto("/");
    await expect(authedPage.getByRole("heading", { level: 1, name: "概览" })).toBeVisible();
    await expect(authedPage).toHaveScreenshot("operation-dashboard-light.png", { fullPage: true });

    await authedPage.goto("/catalog/expert_template/expert-e2e");
    await expect(authedPage.getByRole("heading", { level: 1, name: "E2E 专家" })).toBeVisible();
    await expect(authedPage).toHaveScreenshot("operation-catalog-detail-light.png", { fullPage: true });
    await expectCriticalAxeClean(authedPage);

    await authedPage.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await authedPage.goto("/");
    await expect(authedPage.getByRole("heading", { level: 1, name: "概览" })).toBeVisible();
    await expect(authedPage).toHaveScreenshot("operation-dashboard-dark.png", { fullPage: true });
    await authedPage.goto("/catalog/expert_template/expert-e2e");
    await expect(authedPage.getByRole("heading", { level: 1, name: "E2E 专家" })).toBeVisible();
    await expect(authedPage).toHaveScreenshot("operation-catalog-detail-dark.png", { fullPage: true });
    expect(browserErrors).toEqual([]);
  });
});
