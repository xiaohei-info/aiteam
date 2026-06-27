import { test, expect } from "@playwright/test";
import { collectBrowserErrors, expectApiProblemJson, expectLoginPageSmoke } from "../support/smoke";

test("agent login shell and API contract smoke", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);

  await expectLoginPageSmoke(page, { tier: "agent", loginText: /用户|Agent|登录/i });
  await expectApiProblemJson(request, "agent");

  expect(browserErrors).toEqual([]);
});
