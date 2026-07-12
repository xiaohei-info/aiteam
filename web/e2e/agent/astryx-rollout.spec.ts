import AxeBuilder from "@axe-core/playwright";
import { authTest, expect } from "../support/fixtures";
import {
  collectBrowserErrors,
  expectKeyboardFocusVisible,
} from "../support/smoke";

authTest.describe("Agent Astryx rollout", () => {
  authTest("本地能力与设置页面具备标题、主地标、键盘和可访问性门禁", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    const gates = [
      { path: "/workspace", heading: "工作台" },
      { path: "/marketplace", heading: "人才市场" },
      { path: "/knowledge", heading: "知识库" },
      { path: "/office", heading: "办公室动态" },
      { path: "/org", heading: "组织架构" },
      { path: "/settings", heading: "设置" },
      { path: "/sync", heading: "同步与用量" },
    ];

    for (const gate of gates) {
      await authedPage.goto(gate.path);
      await expect(authedPage.getByRole("heading", { level: 1, name: gate.heading })).toBeVisible();
      await expect(authedPage.getByRole("main")).toBeVisible();
      const results = await new AxeBuilder({ page: authedPage }).analyze();
      expect(
        results.violations.filter((item) => item.impact === "critical" || item.impact === "serious"),
      ).toEqual([]);
      await expectKeyboardFocusVisible(authedPage);
    }

    expect(browserErrors).toEqual([]);
  });
});
