import AxeBuilder from "@axe-core/playwright";
import { authTest, expect } from "../support/fixtures";
import {
  collectBrowserErrors,
  expectKeyboardFocusVisible,
} from "../support/smoke";

const auditEvents = {
  data: [
    {
      event_id: "audit-001",
      event_type: "member.created",
      actor_id: "owner-001",
      target_type: "member",
      target_id: "member-008",
      detail: {},
      created_at: "2026-07-11T08:30:00Z",
    },
    {
      event_id: "audit-002",
      event_type: "grant.updated",
      actor_id: "admin-002",
      target_type: "employee",
      target_id: "employee-021",
      detail: {},
      created_at: "2026-07-11T09:45:00Z",
    },
  ],
  page: { next_cursor: null, has_more: false },
};

async function openAuditBenchmark(page: Parameters<typeof collectBrowserErrors>[0]) {
  await page.route("**/api/manager/audit-events**", async (route) => {
    await route.fulfill({ json: auditEvents });
  });
  await page.goto("/audit");
  await expect(page.getByRole("table", { name: "审计事件" })).toBeVisible();
}

authTest.describe("Manager Astryx Audit benchmark", () => {
  authTest("light mode passes visual, accessibility, keyboard, and console gates", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    await openAuditBenchmark(authedPage);

    await expect(authedPage).toHaveScreenshot("manager-audit-light.png", { fullPage: true });
    const results = await new AxeBuilder({ page: authedPage }).analyze();
    expect(
      results.violations.filter((item) => item.impact === "critical" || item.impact === "serious"),
    ).toEqual([]);
    await expectKeyboardFocusVisible(authedPage);
    expect(browserErrors).toEqual([]);
  });

  authTest("dark mode stays visually stable", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
    await openAuditBenchmark(authedPage);

    await expect(authedPage).toHaveScreenshot("manager-audit-dark.png", { fullPage: true });
    expect(browserErrors).toEqual([]);
  });
});
